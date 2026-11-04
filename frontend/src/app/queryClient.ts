import { QueryClient } from '@tanstack/react-query'
import { ApiError } from '../api/client'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The service worker answers from cache when offline, so queries must still run then.
      networkMode: 'always',
      staleTime: 5_000,
      retry: (count, err) => count < 1 && !(err instanceof ApiError && err.status < 500),
    },
    mutations: { networkMode: 'always' },
  },
})
