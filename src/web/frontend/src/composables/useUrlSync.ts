import { onMounted, onUnmounted, watch, type Ref } from 'vue';

export interface UrlSyncOptions {
  selectedIssueIid: Ref<number | undefined>;
  onOpenIssue: (number: number) => void;
}

/**
 * Syncs `?issue=<number>` query parameter with the selected issue state.
 *
 * - On page load: if the URL contains `?issue=123`, triggers `onOpenIssue(123)`.
 * - When `selectedIssueIid` changes: updates the URL without a page reload.
 * - On browser back/forward (popstate): re-opens or closes the detail panel.
 */
export function useUrlSync(options: UrlSyncOptions) {
  const { selectedIssueIid, onOpenIssue } = options;

  function readIssueIidFromUrl(): number | undefined {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('issue');
    if (!raw) return undefined;
    const number = Number(raw);
    return Number.isFinite(number) && number > 0 ? number : undefined;
  }

  function writeIssueIidToUrl(number: number | undefined) {
    const url = new URL(window.location.href);
    if (number) {
      url.searchParams.set('issue', String(number));
    } else {
      url.searchParams.delete('issue');
    }
    const target = url.pathname + url.search;
    const current = window.location.pathname + window.location.search;
    if (target !== current) {
      window.history.pushState({ issueIid: number ?? null }, '', target);
    }
  }

  function onPopState(e: PopStateEvent) {
    const number = (e.state as { issueIid?: number } | null)?.issueIid ?? readIssueIidFromUrl();
    if (number) {
      onOpenIssue(number);
    } else if (selectedIssueIid.value) {
      selectedIssueIid.value = undefined as never;
    }
  }

  watch(selectedIssueIid, number => writeIssueIidToUrl(number));

  onMounted(() => {
    window.addEventListener('popstate', onPopState);
    window.history.replaceState(
      { issueIid: readIssueIidFromUrl() ?? null },
      '',
      window.location.href,
    );
  });

  onUnmounted(() => {
    window.removeEventListener('popstate', onPopState);
  });

  return { readIssueIidFromUrl };
}
