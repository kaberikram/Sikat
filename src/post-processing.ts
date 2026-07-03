import type { PostProcessingStack, VirtualCamera } from './store'

export type PostSectionId = keyof PostProcessingStack

export function patchCameraPostSection<S extends PostSectionId>(
  vc: VirtualCamera,
  section: S,
  patch: Partial<PostProcessingStack[S]>
): { postProcessing: PostProcessingStack } {
  return {
    postProcessing: {
      ...vc.postProcessing,
      [section]: { ...vc.postProcessing[section], ...patch },
    },
  }
}
