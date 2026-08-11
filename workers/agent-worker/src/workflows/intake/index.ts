// intake queue workflows (09 §2): projectIntakeWorkflow lands in T42. The
// scaffold registers a placeholder so the queue's worker boots and the
// bundle path exists.
export async function intakePlaceholderWorkflow(): Promise<string> {
  return "intake queue scaffold (T42 brings projectIntakeWorkflow)";
}
