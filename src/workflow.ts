import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env, SummaryWorkflowParams } from "./env";
import { runDailySummaryWorkflow, type WorkflowStepLike } from "./workflow-runner";

export class DailySummaryWorkflow extends WorkflowEntrypoint<Env, SummaryWorkflowParams> {
  async run(event: WorkflowEvent<SummaryWorkflowParams>, step: WorkflowStep) {
    return await runDailySummaryWorkflow(
      this.env,
      event.payload,
      event.instanceId,
      step as unknown as WorkflowStepLike,
    );
  }
}
