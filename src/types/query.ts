export enum QueryResultFormat {
	Table,
	JSON,
}

export interface QueryWorkerRequest {
	sql: string;
	format: QueryResultFormat;
	dbFile: string;
}

export type QueryWorkerError = {
	name: string;
	message: string;
};
