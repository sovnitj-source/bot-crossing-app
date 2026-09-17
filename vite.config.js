import path from 'node:path'
import { defineConfig } from 'vite'
import { apiMiddleware } from './server/api.mjs'
import { announceDriveToken } from './server/lib/security.mjs'
import { handleDriveUpgrade } from './server/lib/api-drive.mjs'

/** Serves /api from inside the Vite dev server, so `npm run dev` is the whole game. */
const api = () => ({
  name: 'bot-crossing-api',
  configureServer(server) {
    server.middlewares.use(apiMiddleware)
    server.httpServer?.on('upgrade', handleDriveUpgrade)

    const dataDir = process.env.BOT_CROSSING_DATA || path.join(process.cwd(), 'data')
    announceDriveToken(dataDir).catch(console.error)
  },
})

export default defineConfig({
  plugins: [api()],
  // PORT lets a second copy run alongside the first without a flag on the command line.
  server: { port: Number(process.env.PORT) || 5274, strictPort: false },
  build: { target: 'esnext' },
})
