# 롤 내전 기록실

친구들끼리 롤 내전 팀을 섞고, 승패를 기록하고, 승률·MMR·천적·듀오를 보는 웹페이지예요.
Vercel에 올리면 링크만 있으면 **로그인 없이 누구나** 같은 기록을 봐요.

```
index.html        화면 전체 (팀 섞기, 전적, 분석, 기록)
api/data.js       기록 저장 API (Upstash Redis 사용)
dev-server.mjs    내 컴퓨터에서 테스트용 (메모리에 저장, 배포엔 안 씀)
```

## 배포하기 (처음 한 번, 10분 정도)

### 1. GitHub에 올리기
1. GitHub에서 새 저장소를 만들어요 (예: `lol-naejeon`). Private이어도 괜찮아요.
2. 이 폴더에서:
   ```bash
   git init
   git add .
   git commit -m "롤 내전 기록실"
   git branch -M main
   git remote add origin https://github.com/<내아이디>/lol-naejeon.git
   git push -u origin main
   ```

### 2. Vercel에 프로젝트 만들기
1. https://vercel.com 에 GitHub 계정으로 로그인해요.
2. **Add New → Project** → 방금 만든 저장소를 **Import** 해요.
3. Framework Preset은 **Other** 그대로 두고 **Deploy**를 눌러요.

### 3. 저장소(DB) 연결하기 — 이걸 해야 기록이 저장돼요
1. Vercel 프로젝트 화면 → **Storage** 탭 → **Create Database**.
2. Marketplace에서 **Upstash for Redis**를 고르고, 무료 플랜으로 만들어요.
3. 만든 DB를 이 프로젝트에 **Connect** 해요. 연결 주소와 키가 환경변수로 자동으로 들어가요.
4. **Deployments** 탭에서 가장 최근 배포의 `⋯` → **Redeploy** 를 눌러요.

이제 `https://<프로젝트이름>.vercel.app` 링크를 단톡방에 올리면 끝이에요.
화면 오른쪽 위에 **"모두와 공유 중"** 이 보이면 정상이에요.

### 4. (선택) 기록 비밀번호 걸기
아무나 기록을 지우거나 바꾸는 게 싫다면:
1. 프로젝트 **Settings → Environment Variables** 에서
   이름 `RECORD_PIN`, 값 `원하는 비밀번호` 를 추가해요.
2. 다시 **Redeploy** 해요.

그러면 보기는 누구나 되고, 명단 수정·승패 기록·삭제할 때만 비밀번호를 물어봐요.
한 번 입력하면 그 기기에선 다시 안 물어봐요.

## 내 컴퓨터에서 미리 보기

```bash
npm install
npm run dev
```

http://localhost:3000 에서 열려요. 이때 기록은 메모리에만 저장돼서, 서버를 끄면 사라져요.

## 알아두면 좋은 것
- 다른 사람 화면은 5초마다 새 기록을 받아와요.
- 선수는 이름으로 구분해요. 같은 사람은 항상 같은 이름으로 넣어야 전적이 이어져요.
- 경기 기록은 최대 5000판까지 저장해요.
