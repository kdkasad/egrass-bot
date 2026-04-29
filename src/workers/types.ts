export enum QueryResultFormat {
	Table,
	JSON,
}

export interface QueryWorkerRequest {
	sql: string;
	format: QueryResultFormat;
}
