# Ollama networking

ScholarPen의 생성 모델 요청은 Ollama Cloud(`https://ollama.com/v1`)로 전송됩니다.
Renderer가 Cloud를 직접 호출하지 않고 Bun main process가 RPC로 proxy하므로
`OLLAMA_ORIGINS` 설정은 필요하지 않습니다.

로컬 Ollama는 임베딩 전용입니다. 기본 endpoint는 `http://localhost:11434`이며,
로컬 프로세스에서 호출되므로 이 경로에도 renderer CORS 설정이 필요하지 않습니다.
