import { useEffect, useState } from 'react'

// Plays a recorded clip from a Blob, managing the object URL lifecycle so we
// don't leak the (potentially large) video buffer.
export const VideoView = ({ blob }: { blob: Blob | null }) => {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!blob) {
      setUrl(null)
      return
    }
    const objectUrl = URL.createObjectURL(blob)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [blob])

  if (!url) return null
  return <video className="replay" src={url} controls playsInline preload="metadata" />
}
