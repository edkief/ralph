import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const ok = await ctx.ui.confirm("Run bash?", String(event.input.command));
    if (!ok) return { block: true, reason: "Blocked by extension" };
  });
}
