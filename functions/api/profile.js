import { handle } from '../../server/http.js';
import { profile } from '../../server/handlers.js';
export const onRequestPost = ctx => handle(ctx, profile);
