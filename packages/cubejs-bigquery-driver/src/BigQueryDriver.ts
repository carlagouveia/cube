/**
 * @copyright Cube Dev, Inc.
 * @license Apache-2.0
 * @fileoverview The `BigQueryDriver` and related types declaration.
 */

import {
  getEnv,
  assertDataSource,
  pausePromise,
  Required,
} from '@cubejs-backend/shared';
import R from 'ramda';
import {
  BigQuery,
  BigQueryOptions,
  Dataset,
  Job,
  QueryRowsResponse,
} from '@google-cloud/bigquery';
import { Bucket, Storage } from '@google-cloud/storage';
import {
  BaseDriver,
  DownloadTableCSVData,
  DriverInterface,
  QueryOptions,
  UnloadOptions,
  StreamTableDataWithTypes,
  DownloadQueryResultsOptions,
  DownloadQueryResultsResult,
  DownloadTableMemoryData,
  TableStructure,
  Row,
  DriverCapabilities,
} from '@cubejs-backend/base-driver';
import { Query } from '@google-cloud/bigquery/build/src/bigquery';
import { HydrationStream } from './HydrationStream';

const BQTypeToGenericType: Record<string, string> = {
  array: 'text', // ?
  bignumeric: 'double', // ?
  bool: 'boolean',
  bytes: 'text', // ?
  date: 'date',
  datetime: 'timestamp',
  float64: 'double',
  geography: 'text', // ?
  int64: 'bigint',
  interval: 'text', // ?
  json: 'text', // ?
  numeric: 'double', // ?
  string: 'text',
  struct: 'text',
  time: 'timestamp',
  timestamp: 'timestamp',
};

interface BigQueryDriverOptions extends BigQueryOptions {
  readOnly?: boolean
  projectId?: string,
  keyFilename?: string,
  exportBucket?: string,
  location?: string,
  pollTimeout?: number,
  pollMaxInterval?: number,

  /**
   * The export bucket CSV file escape symbol.
   */
  exportBucketCsvEscapeSymbol?: string,
}

type BigQueryDriverOptionsInitialized =
  Required<BigQueryDriverOptions, 'pollTimeout' | 'pollMaxInterval'>;

/**
 * BigQuery driver.
 */
export class BigQueryDriver extends BaseDriver implements DriverInterface {
  /**
   * Returns default concurrency value.
   */
  public static getDefaultConcurrency(): number {
    return 10;
  }

  protected readonly options: BigQueryDriverOptionsInitialized;

  protected readonly bigquery: BigQuery;

  protected readonly storage: Storage | null = null;

  protected readonly bucket: Bucket | null = null;

  /**
   * Class constructor.
   */
  public constructor(
    config: BigQueryDriverOptions & {
      /**
       * Data source name.
       */
      dataSource?: string,

      /**
       * Max pool size value for the [cube]<-->[db] pool.
       */
      maxPoolSize?: number,

      /**
       * Time to wait for a response from a connection after validation
       * request before determining it as not valid. Default - 10000 ms.
       */
      testConnectionTimeout?: number,
    } = {}
  ) {
    super({
      testConnectionTimeout: config.testConnectionTimeout,
    });

    const dataSource =
      config.dataSource ||
      assertDataSource('default');

    this.options = {
      scopes: [
        'https://www.googleapis.com/auth/bigquery',
        'https://www.googleapis.com/auth/drive',
      ],
      projectId: getEnv('bigqueryProjectId', { dataSource }),
      keyFilename: getEnv('bigqueryKeyFile', { dataSource }),
      credentials: getEnv('bigqueryCredentials', { dataSource })
        ? JSON.parse(
          Buffer.from(
            getEnv('bigqueryCredentials', { dataSource }),
            'base64',
          ).toString('utf8')
        )
        : undefined,
      exportBucket:
        getEnv('dbExportBucket', { dataSource }) ||
        getEnv('bigqueryExportBucket', { dataSource }),
      location: getEnv('bigqueryLocation', { dataSource }),
      readOnly: true,

      ...config,
      
      pollTimeout: (
        config.pollTimeout ||
        getEnv('dbPollTimeout', { dataSource }) ||
        getEnv('dbQueryTimeout', { dataSource })
      ) * 1000,
      pollMaxInterval: (
        config.pollMaxInterval ||
        getEnv('dbPollMaxInterval', { dataSource })
      ) * 1000,
      exportBucketCsvEscapeSymbol:
        getEnv('dbExportBucketCsvEscapeSymbol', { dataSource }),
    };

    getEnv('dbExportBucketType', {
      dataSource,
      supported: ['gcp'],
    });

    this.bigquery = new BigQuery(this.options);
    if (this.options.exportBucket) {
      this.storage = new Storage(this.options);
      this.bucket = this.storage.bucket(this.options.exportBucket);
    }
  }

  public static driverEnvVariables() {
    // TODO (buntarb): check how this method can/must be used with split
    // names by the data source.
    return [
      'CUBEJS_DB_BQ_PROJECT_ID',
      'CUBEJS_DB_BQ_KEY_FILE',
    ];
  }

  /**
   * Driver read-only flag.
   */
  public readOnly() {
    return !!this.options.readOnly;
  }

  /**
   * Returns driver's capabilities object.
   */
  public capabilities(): DriverCapabilities {
    return { unloadWithoutTempTable: true };
  }

  /**
   * Test driver's connection.
   */
  public async testConnection() {
    await this.bigquery.query({
      query: 'SELECT ? AS number', params: ['1']
    });
  }

  /**
   * Determines whether export bucket feature is configured or not.
   */
  public async isUnloadSupported() {
    return this.bucket !== null;
  }

  /**
   * Returns to the Cubestore an object with links to unloaded to the
   * export bucket data.
   */
  public async unload(
    table: string,
    options: UnloadOptions,
  ): Promise<DownloadTableCSVData> {
    if (!this.bucket) {
      throw new Error('Export bucket misconfigured.');
    }
    const types = options.query
      ? await this.unloadWithSql(table, options)
      : await this.unloadWithTable(table);
    const csvFile = await this.getCsvFiles(table);
    return {
      types,
      csvFile,
      csvNoHeader: false,
      exportBucketCsvEscapeSymbol:
        this.options.exportBucketCsvEscapeSymbol,
    };
  }

  /**
   * Unload data from a SQL query to an export bucket.
   */
  private async unloadWithSql(
    table: string,
    options: UnloadOptions,
  ): Promise<TableStructure> {
    if (!this.bucket) {
      throw new Error('Export bucket misconfigured.');
    }
    if (!options.query) {
      throw new Error('Unload query is missed.');
    }
    const types = await this.queryColumnTypes(options.query.sql);
    const unloadSql = `
    EXPORT DATA
    OPTIONS (
      uri='gs://${this.options.exportBucket}/${table}/*.csv.gz',
      format='CSV',
      overwrite=true,
      header=true,
      field_delimiter=',',
      compression='GZIP'
    ) AS
    ${options.query.sql}`;
    await this.query(unloadSql, []);
    return types;
  }

  /**
   * Unload data from a temp table to an export bucket.
   * : Promise<TableStructure>
   */
  private async unloadWithTable(table: string) {
    if (!this.bucket) {
      throw new Error('Export bucket misconfigured.');
    }
    const types = await this.tableColumnTypes(table);
    const [schema, tableName] = table.split('.');
    const bigQueryTable = this.bigquery
      .dataset(schema)
      .table(tableName);
    const [job] = await bigQueryTable.createExtractJob(
      this.bucket.file(`${table}/*.csv.gz`),
      { format: 'CSV', gzip: true },
    );
    await this.waitForJobResult(job, { table }, false);
    return types;
  }

  /**
   * Returns an array of signed URLs of the unloaded csv files.
   */
  private async getCsvFiles(table: string): Promise<string[]> {
    if (!this.bucket) {
      throw new Error('Export bucket misconfigured.');
    }
    const [files] = await this.bucket.getFiles({
      prefix: `${table}/`,
    });
    const csvFiles = await Promise.all(files.map(async file => {
      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: new Date(new Date().getTime() + 60 * 60 * 1000),
      });
      return url;
    }));
    return csvFiles;
  }

  /**
   * Executes a query and returns either query result memory data or
   * query result stream, depending on options.
   */
  public async downloadQueryResults(
    query: string,
    values: unknown[],
    options: DownloadQueryResultsOptions,
  ): Promise<DownloadQueryResultsResult> {
    if (!options.streamImport) {
      return this.memory(query, values);
    } else {
      return this.stream(query, values);
    }
  }

  /**
   * Executes query and returns table memory data that includes rows
   * and queried fields types.
   */
  public async memory(
    query: string,
    values: unknown[],
  ): Promise<DownloadTableMemoryData & { types: TableStructure }> {
    const types = await this.queryColumnTypes(query);
    const rows: Row[] = await this.query(query, values);
    return { types, rows };
  }

  /**
   * Returns stream table object that includes query result stream and
   * queried fields types.
   */
  public async stream(
    query: string,
    values: unknown[]
  ): Promise<StreamTableDataWithTypes> {
    const types = await this.queryColumnTypes(query);
    const stream = await this.bigquery.createQueryStream({
      query,
      params: values,
      parameterMode: 'positional',
      useLegacySql: false
    });
    const rowStream = new HydrationStream();
    stream.pipe(rowStream);
    return {
      rowStream,
      types,
      release: async () => {
        //
      }
    };
  }

  /**
   * Returns an array of queried fields meta info.
   */
  public async queryColumnTypes(sql: string): Promise<TableStructure> {
    const rowSql = `${sql} LIMIT 1`;
    const row = (await this.runQueryJob({
      query: rowSql,
      params: [],
      parameterMode: 'positional',
      useLegacySql: false
    }, {}))[0][0];
    const cols = Object.keys(row)
      .map((f) => (`bqutil.fn.typeof(${f}) AS ${f}`))
      .join(', ');
    const typesSql = `
      WITH ORIGIN AS (${rowSql})
      SELECT ${cols}
      FROM ORIGIN`;
    const types = (await this.runQueryJob({
      query: typesSql,
      params: [],
      parameterMode: 'positional',
      useLegacySql: false
    }, {}))[0][0];
    return Object.keys(types).map((f) => ({
      name: f,
      type: this.toGenericType(types[f]),
    }));
  }

  /**
   * Returns an array of table fields meta info.
   */
  public async tableColumnTypes(table: string) {
    const [schema, name] = table.split('.');
    const [bigQueryTable] = await this.bigquery
      .dataset(schema)
      .table(name)
      .getMetadata();
    return bigQueryTable.schema.fields.map((c: any) => ({
      name: c.name,
      type: this.toGenericType(c.type),
    }));
  }

  /**
   * Returns generic type for the provided BQ type.
   */
  public toGenericType(type: string) {
    return BQTypeToGenericType[type.toLowerCase()] ||
      super.toGenericType(type.toLowerCase());
  }

  /**
   * Executes query and returns queried rows.
   */
  public async query<R = unknown>(
    query: string,
    values: unknown[],
    options?: QueryOptions,
  ): Promise<R[]> {
    const data = await this.runQueryJob({
      query,
      params: values,
      parameterMode: 'positional',
      useLegacySql: false
    }, options);
    return <any>(
      data[0] && data[0].map(
        row => R.map(
          value => (
            value && value.value && typeof value.value === 'string'
              ? value.value
              : value
          ),
          row,
        ),
      )
    );
  }

  protected async loadTablesForDataset(dataset: Dataset) {
    try {
      const result = await dataset.query({
        query: `
        SELECT
          columns.column_name as ${this.quoteIdentifier('column_name')},
          columns.table_name as ${this.quoteIdentifier('table_name')},
          columns.table_schema as ${this.quoteIdentifier('table_schema')},
          columns.data_type as ${this.quoteIdentifier('data_type')}
        FROM INFORMATION_SCHEMA.COLUMNS
      `
      });

      if (result.length) {
        return R.reduce(
          this.informationColumnsSchemaReducer, {}, result[0]
        );
      }

      return [];
    } catch (e) {
      if ((<any>e).message.includes('Permission bigquery.tables.get denied on table')) {
        return {};
      }

      throw e;
    }
  }

  public async tablesSchema() {
    const dataSets = await this.bigquery.getDatasets();
    const dataSetsColumns = await Promise.all(
      dataSets[0].map((dataSet) => this.loadTablesForDataset(dataSet))
    );

    return dataSetsColumns.reduce((prev, current) => Object.assign(prev, current), {});
  }

  public async getTablesQuery(schemaName: string) {
    try {
      const dataSet = await this.bigquery.dataset(schemaName);
      if (!dataSet) {
        return [];
      }
      const [tables] = await this.bigquery.dataset(schemaName).getTables();
      return tables.map(t => ({ table_name: t.id }));
    } catch (e) {
      if ((<any>e).toString().indexOf('Not found')) {
        return [];
      }
      throw e;
    }
  }

  public async createSchemaIfNotExists(schemaName: string): Promise<void> {
    await this.bigquery.dataset(schemaName).get({ autoCreate: true });
  }

  public async loadPreAggregationIntoTable(
    preAggregationTableName: string,
    loadSql: string,
    params: any,
    options: any
  ): Promise<any> {
    const [dataSet, tableName] = preAggregationTableName.split('.');

    const bigQueryQuery: Query = {
      query: loadSql,
      params,
      parameterMode: 'positional',
      destination: this.bigquery.dataset(dataSet).table(tableName),
      createDisposition: 'CREATE_IF_NEEDED',
      useLegacySql: false
    };

    return this.runQueryJob(bigQueryQuery, options, false);
  }

  protected async awaitForJobStatus(job: Job, options: any, withResults: boolean) {
    const [result] = await job.getMetadata();
    if (result.status && result.status.state === 'DONE') {
      if (result.status.errorResult) {
        throw new Error(
          result.status.errorResult.message ?
            result.status.errorResult.message :
            JSON.stringify(result.status.errorResult)
        );
      }
      this.reportQueryUsage(result.statistics, options);
    } else {
      return null;
    }

    return withResults ? job.getQueryResults() : true;
  }

  protected async runQueryJob<T = QueryRowsResponse>(
    bigQueryQuery: Query,
    options: any,
    withResults: boolean = true
  ): Promise<T> {
    const [job] = await this.bigquery.createQueryJob(bigQueryQuery);
    return <any> this.waitForJobResult(job, options, withResults);
  }

  protected async waitForJobResult(job: Job, options: any, withResults: boolean) {
    const startedTime = Date.now();

    for (let i = 0; Date.now() - startedTime <= this.options.pollTimeout; i++) {
      const result = await this.awaitForJobStatus(job, options, withResults);
      if (result) {
        return result;
      }

      await pausePromise(
        Math.min(this.options.pollMaxInterval, 200 * i),
      );
    }

    await job.cancel();

    throw new Error(
      `BigQuery job timeout reached ${this.options.pollTimeout}ms`,
    );
  }

  public quoteIdentifier(identifier: string) {
    const nestedFields = identifier.split('.');
    return nestedFields.map(name => {
      if (name.match(/^[a-z0-9_]+$/)) {
        return name;
      }
      return `\`${identifier}\``;
    }).join('.');
  }
}
