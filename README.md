# claude-mods

Claude Code에서 쓰는 Mod 모음.

## session-work

사이드 패널에 이번 세션에서 바뀐 파일(+/- 줄 수, 최근 diff), 백그라운드 명령·예약 작업·서브에이전트 상태를 보여줍니다.

- 패널 바닥에 도트 캐릭터가 있어요. Claude가 일하는 동안 바쁘게 걸어 다니고, 쉴 때는 졸다가 가끔 산책해요.
- 2분 넘게 걸린 턴이 끝나면 알림을 보내요 (Windows는 토스트 알림). 패널의 버튼으로 끌 수 있어요.
- `VS Code로 열기` 버튼, `/session-work` 명령으로 패널 다시 열기.

### 설치

터미널의 Claude Code 프롬프트에서:

```
/plugin install session-work --marketplace Sin-Yejun/claude-mods
```

`Add marketplace?`에 `y`, 그다음 설치 범위를 고르면 끝이에요.

셸에서:

```
claude plugin install session-work --marketplace Sin-Yejun/claude-mods
```

데스크탑 앱에서는 `/plugin`이 안 돼요: 프롬프트 옆 + → Plugins → Add marketplace에 `Sin-Yejun/claude-mods` → Add plugin.
