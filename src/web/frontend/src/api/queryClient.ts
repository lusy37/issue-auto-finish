import { QueryClient } from '@tanstack/vue-query';

/** SSE 负责刷新时机；查询库负责缓存、去重和请求生命周期。 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false, gcTime: 60_000,
    },
    mutations: { retry: false },
  },
});

export function invalidateWorkbench(number?: number) {
  void queryClient.invalidateQueries({ queryKey: ['tasks'] });
  void queryClient.invalidateQueries({ queryKey: number ? ['issue', number] : ['issue'] });
}
