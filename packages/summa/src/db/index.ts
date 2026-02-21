export {
	createInternalAdapter,
	type InternalAdapter,
	type InternalAdapterOptions,
} from "./internal-adapter.js";
export {
	generatePartitionDDL,
	type PartitionDDLOptions,
	type PartitionInterval,
	type PartitionMaintenanceOptions,
	type PartitionTableConfig,
	partitionMaintenance,
} from "./partitioning.js";
export { getCoreTables, getSummaTables } from "./schema.js";
