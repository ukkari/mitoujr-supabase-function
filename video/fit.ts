import type { VideoPlan } from "./types";

export type TooLong = { index: number; natural: number; window: number; alone?: boolean };

// When narration still does not fit after shortening, one scene gives way instead of the whole video
// failing; its channel is then named in the roll call. A clip that is too long on its own goes first,
// then a channel's extra scene, then the scene of the quietest channel (the later one on a tie).
export function sceneToDrop(plan: Pick<VideoPlan, "scenes" | "sources">, tooLong: TooLong[]): number {
  const alone = tooLong.find((clip) => clip.alone && plan.scenes[clip.index]);
  if (alone) return alone.index;
  const scenes = new Map<number, number>();
  for (const scene of plan.scenes) scenes.set(scene.source, (scenes.get(scene.source) ?? 0) + 1);
  let drop = 0, least = Infinity;
  plan.scenes.forEach((scene, index) => {
    const posts = scenes.get(scene.source)! > 1 ? -1 : plan.sources[scene.source]?.posts ?? 0;
    if (posts <= least) { least = posts; drop = index; }
  });
  return drop;
}
