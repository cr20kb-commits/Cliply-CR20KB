import type { CompactMode } from "@/lib/api"
import { useYouTubeStore } from "@/lib/youtubeStore"
import { Archive } from "lucide-react"
import { SelectionDropdown } from "./SelectionDropdown"

type CompactOption = {
  value: CompactMode
  label: string
  detail: string
}

const COMPACT_OPTIONS: CompactOption[] = [
  { value: "original", label: "Original", detail: "No conversion" },
  { value: "h265-1080p", label: "1080p H.265", detail: "High quality" },
  { value: "h265-720p", label: "720p H.265", detail: "Compact" },
  { value: "h265-480p", label: "480p H.265", detail: "Minimum size" }
]

export function CompactModeDropdown({
  isVisible,
  onOpenChange
}: {
  isVisible: boolean
  onOpenChange?: (isOpen: boolean) => void
}) {
  const { selectedCompactMode, setSelectedCompactMode } = useYouTubeStore()

  if (!isVisible) return null

  const selected =
    COMPACT_OPTIONS.find((option) => option.value === selectedCompactMode) ||
    COMPACT_OPTIONS[0]

  return (
    <SelectionDropdown
      icon={Archive}
      heading="Compact Mode"
      placeholder="Choose how the finished video is stored"
      options={COMPACT_OPTIONS}
      selected={selected}
      onSelect={(option) => setSelectedCompactMode(option.value)}
      optionKey={(option) => option.value}
      renderLabel={(option) => option.label}
      renderDetail={(option) => option.detail}
      onOpenChange={onOpenChange}
      footer={
        selected.value === "original" ? undefined : (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Cliply keeps the original unless FFmpeg produces a verified,
            strictly smaller file.
          </p>
        )
      }
    />
  )
}
