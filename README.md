# 식물 관찰 학습 웹앱

## 준비물

- Windows
- Node.js 18 이상
- Docker에서 실행 중인 AnythingLLM
- AnythingLLM Developer API 키

## 실행 방법

1. `.env` 파일을 메모장으로 엽니다.
2. 다음 두 항목을 입력하고 저장합니다.

   ```env
   ANYTHINGLLM_API_KEY=발급받은_Developer_API_키
   ANYTHINGLLM_WORKSPACE_SLUG=워크스페이스_slug
   ```

   `workspace slug`는 AnythingLLM 워크스페이스 주소의 `/workspace/` 뒤에
   표시되는 값입니다.

3. Docker AnythingLLM이 `http://localhost:3001`에서 실행 중인지 확인합니다.
4. `start.bat`을 더블 클릭합니다.
5. 브라우저에서 `http://127.0.0.1:8765`를 엽니다.

`.env`를 수정했다면 실행 중인 서버 창에서 `Ctrl+C`를 누른 후
`start.bat`을 다시 실행해야 합니다.

## Railway 배포

1. Railway에서 `yoonzero302/Ai-Agent` 저장소의 `main` 브랜치를 서비스로 추가합니다. 시작 명령은 `npm start`입니다. 서비스의 Healthcheck Path를 `/healthz`로 지정하고 학습 페이지에 Railway 도메인을 생성합니다.
2. 같은 프로젝트와 환경에 `anythingllm` 서비스를 추가합니다. Docker 이미지는 `mintplexlabs/anythingllm:railway`를 사용합니다. `PORT`와 `SERVER_PORT`는 `3001`, `STORAGE_DIR`는 `/storage`로 지정하고 같은 `/storage` 경로에 볼륨을 붙입니다.
3. AnythingLLM 관리자 화면은 [Railway SSH 로컬 포트 포워딩](https://docs.railway.com/cli/ssh#forward-a-port-with-ssh--l)으로 열 수 있습니다. 로컬 포트 `13001`을 AnythingLLM 컨테이너의 `127.0.0.1:3001`로 연결한 뒤 브라우저에서 `http://localhost:13001`을 엽니다. AnythingLLM에서 관리자 접근을 설정하고 사용할 모델을 연결한 뒤 식물 관찰용 워크스페이스를 만듭니다. 사진 질문에는 이미지를 지원하는 모델이 필요합니다. Settings → Developer API에서 이 인스턴스의 API 키를 발급합니다.
4. 아래 값을 **학습 페이지 서비스의 Variables**에 추가한 다음 변경사항을 배포합니다. 키는 Railway에 저장합니다.

   ```env
   ANYTHINGLLM_URL=http://${{anythingllm.RAILWAY_PRIVATE_DOMAIN}}:3001
   ANYTHINGLLM_API_KEY=Railway에서_실행_중인_AnythingLLM의_Developer_API_키
   ANYTHINGLLM_WORKSPACE_SLUG=식물_관찰_워크스페이스_slug
   ```

5. `/healthz`에서 웹 서버 상태를 확인하고, `/api/health`에서 AnythingLLM 연결 상태를 확인합니다. 학습 페이지 대화창에 질문을 보내 모델 응답까지 확인합니다.

## 보안 및 기능 안내

- API 키는 브라우저로 전달되지 않고 Node.js 서버에서만 사용됩니다.
- `.env`는 Git에 포함되지 않습니다.
- 왼쪽에서 선택한 사진과 문서(워드, 파워포인트, 엑셀, 텍스트, PDF 등)는 질문과 함께 AnythingLLM으로 전송됩니다.
- AI가 생성한 파일이 AnythingLLM에서 오지 않더라도, 워드/엑셀/텍스트 요청이면 웹앱이 답변 본문으로 파일을 만들어 첨부합니다.
- 이미지는 비전 모델이 직접 보고, 문서는 AnythingLLM 문서 처리기로 읽힌 뒤 답변에 사용됩니다.
- 첨부 없이 글로만 질문할 수도 있습니다.

## 문제 해결

- `설정 필요`: `.env`의 API 키와 workspace slug를 확인합니다.
- `API 키가 올바르지 않습니다`: AnythingLLM의 Developer API에서 발급한 키인지 확인합니다.
- `연결할 수 없습니다`: Docker와 AnythingLLM이 실행 중인지 확인합니다.
- `포트 8765가 이미 사용 중`: 기존에 실행한 `start.bat` 창을 종료합니다.
