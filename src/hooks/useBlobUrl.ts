import { useEffect, useState } from 'react';
import { getMediaBlob } from '../lib/storage';

export function useBlobUrl(blobId: string | undefined): { url: string | null; blob: Blob | null } {
  const [state, setState] = useState<{ url: string | null; blob: Blob | null }>({
    url: null,
    blob: null,
  });

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;

    if (!blobId) {
      setState({ url: null, blob: null });
      return;
    }

    getMediaBlob(blobId)
      .then((blob) => {
        if (!active) return;
        if (!blob) {
          setState({ url: null, blob: null });
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, blob });
      })
      .catch(() => {
        if (active) setState({ url: null, blob: null });
      });

    return () => {
      active = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [blobId]);

  return state;
}

export function formatTimecode(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}
