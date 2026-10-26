import { AVAILABILITY_HIDE } from '@app/components/Discover/constants';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import { MediaStatus } from '@server/constants/media';
import { useEffect } from 'react';
import { useIntl } from 'react-intl';
import useSWRInfinite from 'swr/infinite';
import useSettings from './useSettings';
import { Permission, useUser } from './useUser';

export interface BaseSearchResult<T> {
  page: number;
  totalResults: number;
  totalPages: number;
  results: T[];
}

interface BaseMedia {
  id: number;
  mediaType: string;
  mediaInfo?: {
    status: MediaStatus;
    hasActiveRequest?: boolean;
  };
}

interface DiscoverResult<T, S> {
  isLoadingInitialData: boolean;
  isLoadingMore: boolean;
  fetchMore: () => void;
  isEmpty: boolean;
  isReachingEnd: boolean;
  error: unknown;
  titles: T[];
  firstResultData?: BaseSearchResult<T> & S;
  mutate?: () => void;
}

const extraEncodes: [RegExp, string][] = [
  [/\(/g, '%28'],
  [/\)/g, '%29'],
  [/!/g, '%21'],
  [/\*/g, '%2A'],
];

/**
 * How many visible rows the availability filter tries to have on hand before it
 * stops pulling extra upstream pages, and the hard ceiling on those pulls.
 *
 * The ceiling matters: a result set where nearly everything is already in the
 * library would otherwise walk every page of a 1000-page TMDB response.
 */
const AVAILABILITY_MIN_VISIBLE = 20;
const AVAILABILITY_MAX_PAGES = 12;

export const encodeURIExtraParams = (string: string): string => {
  let finalString = encodeURIComponent(string);

  extraEncodes.forEach((encode) => {
    finalString = finalString.replace(encode[0], encode[1]);
  });

  return finalString;
};

const useDiscover = <
  T extends BaseMedia,
  S = Record<string, never>,
  O = Record<string, unknown>,
>(
  endpoint: string,
  options?: O,
  { hideAvailable = true, hideBlocklisted = true, hideRequested = true } = {}
): DiscoverResult<T, S> => {
  const settings = useSettings();
  const { hasPermission } = useUser();
  const { addToast } = useToasts();
  const intl = useIntl();

  // `availability` is a frontend-only browse param. It must NOT reach the
  // discover API, which rejects unknown query params with
  // 400 "Unknown query parameter". Strip it here and apply it to the fetched
  // results below.
  const { availability, ...upstreamOptions } = (options ?? {}) as unknown as {
    availability?: string;
  } & Record<string, unknown>;

  // Strict comparison on purpose. The ON-by-default behavior is owned by the
  // two pages that actually mount the toggle (DiscoverMovies, DiscoverTv), which
  // resolve the default before calling this hook. Defaulting here instead would
  // silently filter every other consumer -- genre, studio, network, language,
  // trending, upcoming, watchlist -- none of which has a control to turn it off.
  const hideAvailableOrRequested = availability === AVAILABILITY_HIDE;

  const { data, error, size, setSize, isValidating, mutate } = useSWRInfinite<
    BaseSearchResult<T> & S
  >(
    (pageIndex: number, previousPageData) => {
      if (previousPageData && pageIndex + 1 > previousPageData.totalPages) {
        return null;
      }

      const params: Record<string, unknown> = {
        page: pageIndex + 1,
        ...upstreamOptions,
      };

      const finalQueryString = Object.keys(params)
        .map(
          (paramKey) =>
            `${paramKey}=${encodeURIExtraParams(params[paramKey] as string)}`
        )
        .join('&');

      return `${endpoint}?${finalQueryString}`;
    },
    {
      initialSize: 3,
      revalidateFirstPage: false,
      dedupingInterval: 30000,
      revalidateOnFocus: false,
    }
  );

  const resultIds: Set<number> = new Set<number>();

  const isLoadingInitialData = !data && !error;
  const isLoadingMore =
    isLoadingInitialData ||
    (size > 0 &&
      !!data &&
      typeof data[size - 1] === 'undefined' &&
      isValidating);

  const fetchMore = () => {
    setSize(size + 1);
  };

  let titles = (data ?? []).reduce((a, v) => {
    const results: T[] = [];

    for (const result of v.results) {
      if (!resultIds.has(result.id)) {
        resultIds.add(result.id);
        results.push(result);
      }
    }

    return [...a, ...results];
  }, [] as T[]);

  if (settings.currentSettings.hideAvailable && hideAvailable) {
    titles = titles.filter(
      (i) =>
        !(i.mediaType === 'movie' || i.mediaType === 'tv') ||
        (i.mediaInfo?.status !== MediaStatus.AVAILABLE &&
          i.mediaInfo?.status !== MediaStatus.PARTIALLY_AVAILABLE)
    );
  }

  if (
    settings.currentSettings.hideBlocklisted &&
    hideBlocklisted &&
    hasPermission(Permission.MANAGE_BLOCKLIST)
  ) {
    titles = titles.filter(
      (i) =>
        !(i.mediaType === 'movie' || i.mediaType === 'tv') ||
        i.mediaInfo?.status !== MediaStatus.BLOCKLISTED
    );
  }

  if (settings.currentSettings.hideRequested && hideRequested) {
    titles = titles.filter((i) => {
      if (i.mediaType !== 'movie' && i.mediaType !== 'tv') {
        return true;
      }

      return !i.mediaInfo?.hasActiveRequest;
    });
  }

  // Per-browse availability filter (the `availability` URL param), independent
  // of the global hideAvailable/hideRequested settings above.
  //
  // This keys off mediaInfo.status only. `hasActiveRequest` is NOT usable here:
  // the server only populates it when main.hideRequested is enabled
  // (server/entity/Media.ts), so it is undefined on every row for us. Status
  // covers requests anyway, since requesting moves media to PENDING (awaiting
  // approval) or PROCESSING (approved, downloading).
  //
  // BLOCKLISTED and DELETED are deliberately left visible: blocklisting has its
  // own setting and permission handling, and a deleted title is a legitimate
  // re-request candidate.
  if (hideAvailableOrRequested) {
    titles = titles.filter((i) => {
      if (i.mediaType !== 'movie' && i.mediaType !== 'tv') {
        return true;
      }

      if (i.mediaInfo?.hasActiveRequest) {
        return false;
      }

      switch (i.mediaInfo?.status) {
        case MediaStatus.AVAILABLE:
        case MediaStatus.PARTIALLY_AVAILABLE:
        case MediaStatus.PROCESSING:
        case MediaStatus.PENDING:
          return false;
        default:
          return true;
      }
    });
  }

  // Ragged pagination compensation.
  //
  // isReachingEnd and the infinite-scroll sentinel are computed from RAW
  // upstream page counts, never from the filtered array, so a page that is
  // mostly filtered out can leave the grid near-empty with no way to ask for
  // more. MediaSlider has its own version of this loop; the discover pages had
  // none, which only became visible once this filter defaulted to on.
  const lastPage = data && data.length > 0 ? data[data.length - 1] : undefined;
  const needsMorePagesForFilter =
    hideAvailableOrRequested &&
    !!lastPage &&
    titles.length < AVAILABILITY_MIN_VISIBLE &&
    size < AVAILABILITY_MAX_PAGES &&
    size < (lastPage?.totalPages ?? 0);

  useEffect(() => {
    if (needsMorePagesForFilter && !isValidating) {
      setSize(size + 1);
    }
  }, [needsMorePagesForFilter, isValidating, setSize, size]);

  // While the loop above is still topping the grid up, the view is not empty and
  // has not reached the end. Reporting either would flash "No results" and stop
  // pagination on a result set that still has unread pages.
  const isEmpty =
    !isLoadingInitialData && !needsMorePagesForFilter && titles?.length === 0;
  const isReachingEnd =
    !needsMorePagesForFilter &&
    (isEmpty ||
      (!!data && (data[data?.length - 1]?.results.length ?? 0) < 20) ||
      (!!data && (data[data?.length - 1]?.totalResults ?? 0) <= size * 20) ||
      (!!data && (data[data?.length - 1]?.totalResults ?? 0) < 41));

  useEffect(() => {
    if (error && titles.length) {
      addToast(intl.formatMessage(globalMessages.error), {
        appearance: 'error',
        autoDismiss: true,
      });
      console.error('Error while fetching discover titles:', error);
    }
  }, [data, error, addToast, intl, titles.length]);

  return {
    isLoadingInitialData,
    isLoadingMore,
    fetchMore,
    isEmpty,
    isReachingEnd,
    error: error && titles.length ? null : error,
    titles,
    firstResultData: data?.[0],
    mutate,
  };
};

export default useDiscover;
