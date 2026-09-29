import { SummaryRunRepository } from "./db";
import { stablePendingPostId } from "./domain/idempotency";
import type { Env, SummaryWorkflowParams } from "./env";
import { isDryRun } from "./env";
import { MattermostClient } from "./mattermost";
import {
  collectSummaryChannel,
  generateSummaryImage,
  generateTextSummary,
  prepareSummaryCollection,
} from "./summary";
import { dispatchSummaryVideo } from "./video-dispatch";

type StepOptions = {
  retries: {
    limit: number;
    delay: string;
    backoff: "constant" | "linear" | "exponential";
  };
};

export interface WorkflowStepLike {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(name: string, options: StepOptions, callback: () => Promise<T>): Promise<T>;
}

type Repository = Pick<
  SummaryRunRepository,
  | "saveInput"
  | "appendInputFragment"
  | "loadInput"
  | "saveSummary"
  | "loadSummary"
  | "clearContent"
>;

type Mattermost = Pick<
  MattermostClient,
  "postSummary" | "uploadSummaryFile" | "postSummaryWithFile"
>;

export type WorkflowRunnerDependencies = {
  repository: Repository;
  mattermost: () => Mattermost;
  prepareCollection: typeof prepareSummaryCollection;
  collectChannel: typeof collectSummaryChannel;
  generateText: typeof generateTextSummary;
  generateImage: typeof generateSummaryImage;
  pendingPostId: typeof stablePendingPostId;
  dispatchVideo: typeof dispatchSummaryVideo;
};

function defaultDependencies(env: Env): WorkflowRunnerDependencies {
  return {
    repository: SummaryRunRepository.fromEnv(env),
    mattermost: () => new MattermostClient(env),
    prepareCollection: prepareSummaryCollection,
    collectChannel: collectSummaryChannel,
    generateText: generateTextSummary,
    generateImage: generateSummaryImage,
    pendingPostId: stablePendingPostId,
    dispatchVideo: dispatchSummaryVideo,
  };
}

export async function runDailySummaryWorkflow(
  env: Env,
  params: SummaryWorkflowParams,
  instanceId: string,
  step: WorkflowStepLike,
  suppliedDependencies?: WorkflowRunnerDependencies,
) {
  const dependencies = suppliedDependencies ?? defaultDependencies(env);
  const repository = dependencies.repository;
  const collectionPlan = await step.do(
    "list-mattermost-channels",
    { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
    async () => {
      const plan = await dependencies.prepareCollection(
        env,
        params.target,
        params.targetDateJst,
      );
      await repository.saveInput(instanceId, {
        summaryRaw: "",
        label: plan.label,
        targetDateJst: plan.targetDateJst,
      });
      return { ...plan, channelCount: plan.channels.length };
    },
  );

  let contentLength = 0;
  for (let index = 0; index < collectionPlan.channels.length; index += 1) {
    const channel = collectionPlan.channels[index];
    const metadata = await step.do(
      `collect-mattermost-channel-${index + 1}`,
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
      async () => {
        const fragment = await dependencies.collectChannel(env, collectionPlan, channel);
        await repository.appendInputFragment(
          instanceId,
          index,
          channel.id,
          fragment,
        );
        return { channelId: channel.id, contentLength: fragment.length };
      },
    );
    contentLength += metadata.contentLength;
  }

  const inputMetadata = {
    targetDateJst: collectionPlan.targetDateJst,
    label: collectionPlan.label,
    contentLength,
    hasContent: contentLength > 0,
  };

  if (!inputMetadata.hasContent) {
    const published = await step.do("publish-no-updates", async () => {
      if (isDryRun(env)) return { dryRun: true, outcome: "no-updates" };
      const pendingPostId = await dependencies.pendingPostId(
        instanceId,
        env.ADMIN_TRIGGER_SECRET,
      );
      const post = await dependencies.mattermost().postSummary(
        `${inputMetadata.label}は更新がありませんでした。`,
        undefined,
        pendingPostId,
      );
      return { outcome: "no-updates", postId: post.id };
    });
    await clearTemporaryContent(step, repository, instanceId);
    return published;
  }

  const summaryMetadata = await step.do(
    "generate-text-summary",
    { retries: { limit: 3, delay: "15 seconds", backoff: "exponential" } },
    async () => {
      const input = await repository.loadInput(instanceId);
      const summary = await dependencies.generateText(env, input);
      await repository.saveSummary(instanceId, summary);
      return { summaryLength: summary.length };
    },
  );

  if (isDryRun(env)) {
    await clearTemporaryContent(step, repository, instanceId);
    return {
      dryRun: true,
      targetDateJst: inputMetadata.targetDateJst,
      contentLength: inputMetadata.contentLength,
      summaryLength: summaryMetadata.summaryLength,
    };
  }

  let uploadedImage: { fileId: string; altText: string } | null = null;
  try {
    uploadedImage = await step.do(
      "generate-and-upload-image",
      { retries: { limit: 2, delay: "20 seconds", backoff: "exponential" } },
      async () => {
        const [input, summary] = await Promise.all([
          repository.loadInput(instanceId),
          repository.loadSummary(instanceId),
        ]);
        const image = await dependencies.generateImage(env, summary, input);
        const fileId = await dependencies.mattermost().uploadSummaryFile(image.bytes);
        return { fileId, altText: image.altText };
      },
    );
  } catch (error) {
    console.error("Summary image failed; publishing text fallback", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const published = await step.do(
    "publish-summary",
    { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
    async () => {
      const summary = await repository.loadSummary(instanceId);
      const pendingPostId = await dependencies.pendingPostId(
        instanceId,
        env.ADMIN_TRIGGER_SECRET,
      );
      const post = await dependencies.mattermost().postSummaryWithFile(
        summary,
        uploadedImage?.fileId ?? null,
        uploadedImage?.altText,
        pendingPostId,
      );
      return {
        outcome: uploadedImage ? "posted-with-image" : "posted-text-fallback",
        postId: post.id,
      };
    },
  );
  await clearTemporaryContent(step, repository, instanceId);
  if (params.requestedBy === "cron") {
    try {
      await step.do(
        "dispatch-summary-video",
        { retries: { limit: 3, delay: "15 seconds", backoff: "exponential" } },
        async () => {
          const result = await dependencies.dispatchVideo(env, inputMetadata.targetDateJst);
          return { targetDateJst: inputMetadata.targetDateJst, ...result };
        },
      );
    } catch (error) {
      // The text/image summary must remain complete so the video can attach to its thread.
      console.error("Summary video dispatch failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return published;
}

async function clearTemporaryContent(
  step: WorkflowStepLike,
  repository: Repository,
  instanceId: string,
): Promise<void> {
  await step.do("clear-temporary-content", async () => {
    await repository.clearContent(instanceId);
    return { cleared: true };
  });
}
