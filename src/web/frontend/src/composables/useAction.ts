import { ref } from 'vue';
/** 面板请求统一处理错误和重复提交。 */
export function useAction() {
  const busy = ref(false), error = ref('');
  async function run(action: () => Promise<unknown>) {
    if (busy.value) return;
    busy.value = true; error.value = '';
    try { await action(); } catch (e) { error.value = (e as Error).message; } finally { busy.value = false; }
  }
  return { busy, error, run };
}
