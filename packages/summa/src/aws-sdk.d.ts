// Ambient declaration for optional @aws-sdk/client-s3 dependency.
// The backup plugin dynamically imports this at runtime; the types
// are only needed so TypeScript doesn't error on the import().
declare module "@aws-sdk/client-s3" {
	export class S3Client {
		constructor(config: { region: string });
		send(command: unknown): Promise<unknown>;
	}
	export class PutObjectCommand {
		constructor(input: {
			Bucket: string;
			Key: string;
			Body: unknown;
			ContentType?: string;
		});
	}
}
