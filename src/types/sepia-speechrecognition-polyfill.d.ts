declare module 'sepia-speechrecognition-polyfill' {
  /**
   * Connection settings for the SEPIA STT server. Defaults match a stock
   * Docker install (http://localhost:20741, common token "test1234").
   */
  export class SepiaSpeechRecognitionConfig {
    serverUrl: string
    clientId: string
    accessToken: string
    task: string
    model: string
    optimizeFinalResult: boolean
    engineOptions: Record<string, unknown>
  }

  /**
   * Returns a SpeechRecognition-compatible class bound to the given server
   * config. Untyped upstream — cast to your SpeechRecognition interface.
   */
  export function sepiaSpeechRecognitionInit(
    config: SepiaSpeechRecognitionConfig
  ): new () => unknown
}
