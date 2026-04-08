"use client";

export default function WindowBar() {
  return (
    <div className="h-[38px] bg-fms-bg-subtle flex items-center pl-3.5 flex-shrink-0" aria-hidden>
      <div className="flex gap-2">
        <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
        <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
        <span className="w-3 h-3 rounded-full bg-[#28c840]" />
      </div>
    </div>
  );
}
