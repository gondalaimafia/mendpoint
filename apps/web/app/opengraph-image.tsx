import { ImageResponse } from "next/og";

export const alt = "Mendpoint private design partner preview";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px",
          color: "#e8f0ec",
          background: "#0b0f0e",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "18px", fontSize: "30px", fontWeight: 700 }}>
          <div style={{ width: "28px", height: "28px", borderRadius: "7px", background: "#34d399" }} />
          Mendpoint
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          <div style={{ color: "#34d399", fontSize: "24px", letterSpacing: "0.08em", textTransform: "uppercase" }}>
            Private Design Partner Preview
          </div>
          <div style={{ maxWidth: "1000px", fontSize: "64px", lineHeight: 1.05, fontWeight: 700 }}>
            Evidence backed API migration pull request candidates
          </div>
          <div style={{ color: "#8aa399", fontSize: "28px" }}>
            Supported GitHub repositories, configured checks, human review
          </div>
        </div>
      </div>
    ),
    size,
  );
}
