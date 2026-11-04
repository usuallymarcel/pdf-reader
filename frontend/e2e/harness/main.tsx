import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import '../../src/styles/tokens.css'
import '../../src/styles/base.css'
import ReaderPage from '../../src/reader/ReaderPage'
import { Toasts } from '../../src/ui/primitives'

const id = new URLSearchParams(location.search).get('id') ?? 'manga'
const client = new QueryClient({ defaultOptions: { queries: { networkMode: 'always' } } })

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/read/${id}`]}>
        <Routes>
          <Route path="/read/:id" element={<ReaderPage />} />
          <Route path="*" element={<div id="left-reader">library</div>} />
        </Routes>
      </MemoryRouter>
      <Toasts />
    </QueryClientProvider>
  </StrictMode>,
)
