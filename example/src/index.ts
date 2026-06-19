import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { foo } from './foo';

const app = new Hono();

app.get('/', (ctx) => ctx.json(foo()));

serve(
  {
    port: 3000,
    fetch: app.fetch,
  },
  (info) => {
    console.log(`Server listening on http://localhost:${info.port}`);
  },
);
