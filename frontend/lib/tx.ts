/**
 * Reading a GenLayer transaction the same way on every network.
 *
 * Bradbury's records carry `statusName` and `txExecutionResultName`. Studionet's carry a numeric `status` (and `statusName` only on a
 * fresh getTransaction, not on a receipt) and no execution result name at all: whether the contract ran is the leader's
 * `execution_result` (SUCCESS or ERROR). These two functions give the names the rest of the app already speaks.
 */
const STATUS_NAMES: Record<string, string> = {
  "0": "UNINITIALIZED",
  "1": "PENDING",
  "2": "PROPOSING",
  "3": "COMMITTING",
  "4": "REVEALING",
  "5": "ACCEPTED",
  "6": "UNDETERMINED",
  "7": "FINALIZED",
  "8": "CANCELED",
  "9": "APPEAL_REVEALING",
  "10": "APPEAL_COMMITTING",
  "11": "READY_TO_FINALIZE",
  "12": "VALIDATORS_TIMEOUT",
  "13": "LEADER_TIMEOUT",
};

/** PENDING, PROPOSING, ACCEPTED, FINALIZED ... for a transaction or a receipt from either network ("" when unknown). */
export function txStatusName(tx: any): string {
  if (typeof tx?.statusName === "string" && tx.statusName !== "") return tx.statusName;
  if (typeof tx?.status === "string" && Number.isNaN(Number(tx.status))) return tx.status;
  const n = tx?.status;
  return n === undefined || n === null ? "" : STATUS_NAMES[String(n)] ?? "";
}

/**
 * FINISHED_WITH_RETURN when the contract ran and returned, FINISHED_WITH_ERROR when it ran and refused, NOT_VOTED / IDLE when validators
 * never completed it, and "" when nothing is known yet.
 */
export function txExecName(tx: any): string {
  if (typeof tx?.txExecutionResultName === "string" && tx.txExecutionResultName !== "") return tx.txExecutionResultName;
  const leader = tx?.consensus_data?.leader_receipt;
  const first = Array.isArray(leader) ? leader[0] : leader;
  const run = first?.execution_result;
  if (run === "SUCCESS") return "FINISHED_WITH_RETURN";
  if (run === "ERROR") return "FINISHED_WITH_ERROR";
  const result = tx?.result_name ?? tx?.resultName;
  return result === "IDLE" || result === "NOT_VOTED" ? "NOT_VOTED" : "";
}
