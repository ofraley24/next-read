import { handle } from '../../server/http.js';
import { recommend } from '../../server/handlers.js';
export const onRequestPost = ctx => handle(ctx, recommend);
