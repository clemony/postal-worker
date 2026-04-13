import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const PATCH_VERSIONS_URL = "https://ddragon.leagueoflegends.com/api/versions.json"
const __dirname = dirname(fileURLToPath(import.meta.url))
const PATCH_INDEX_PATH = resolve(__dirname, "patch-index.json")

function normalizePatch(version: string) {
  return version.split(".").slice(0, 2).join(".")
}

async function fetchPatchIndex() {
  const response = await fetch(PATCH_VERSIONS_URL)

  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${PATCH_VERSIONS_URL}: ${response.status} ${response.statusText}`,
    )
  }

  const versions = (await response.json()) as string[]
  const normalized = versions.map(normalizePatch).filter(Boolean)

  return [...new Set(normalized)]
}

async function main() {
  const patchIndex = await fetchPatchIndex()

  await mkdir(dirname(PATCH_INDEX_PATH), { recursive: true })
  await writeFile(PATCH_INDEX_PATH, JSON.stringify(patchIndex, null, 2) + "\n")

  console.log(`✅ Patch index written to ${PATCH_INDEX_PATH}`)
  console.log(`   Latest patch: ${patchIndex[0] ?? "unknown"}`)
}

main().catch((error) => {
  console.error("❌ Failed to update patch index")
  console.error(error)
  process.exit(1)
})
