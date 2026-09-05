/**
 * Cloudflare Pages Functions 진입점
 *
 * Pages 는 `functions/` 아래 파일을 자동으로 라우팅한다.
 * 이 파일은 `/api/` 로 시작하는 모든 요청을 받아
 * `worker/index.js` 의 처리기로 그대로 넘긴다.
 *
 * 로직을 복사하지 않고 넘기기만 하므로,
 * API 를 고칠 때는 `worker/index.js` 한 곳만 고치면 된다.
 */

import handler from '../../worker/index.js';

export const onRequest = (context) => handler.fetch(context.request, context.env);
