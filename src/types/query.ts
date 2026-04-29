export enum QueryResultFormat {
	Table,
	JSON,
}

export interface QueryWorkerRequest {
	sql: string;
	format: QueryResultFormat;
	dbFile: string;
}

export type QueryWorkerResult =
	| {
			status: "error";
			error: Error;
			originalErrorName: string;
	  }
	| {
			status: "success";
			formattedResult: string | null;
	  };
