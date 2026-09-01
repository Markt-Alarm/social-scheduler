"use strict";

import { QaBlockedError, graphConfig, headObject, presignGet, publishPlatform } from "./cloud-lib.mjs";
import { metaCredentials, tiktokCredentials, youtubeCredentials } from "./provider-credentials.mjs";
import { publishTikTok } from "./provider-tiktok.mjs";
import { publishYouTube } from "./provider-youtube.mjs";

function metaAccount(item) {
  const account = item.account ?? {};
  return {
    pageId: account.pageId ?? account.meta?.pageId ?? "",
    instagramAccountId: account.instagramAccountId ?? account.meta?.instagramAccountId ?? ""
  };
}

async function publishMeta({ r2Credentials, item, target, state, checkpoint }) {
  const isCarousel = item.kind === "carousel";
  const mediaUrl = isCarousel ? undefined : presignGet(r2Credentials, item.media.objectKey, 3600);
  const mediaUrls = isCarousel ? item.media.slides.map((slide) => presignGet(r2Credentials, slide.objectKey, 3600)) : [];
  const credentials = metaCredentials(item);
  return publishPlatform({
    config: graphConfig(),
    socialPackage: {
      kind: item.kind,
      caption: item.caption,
      media: { path: isCarousel ? undefined : item.media.path },
      options: item.options ?? { instagram: { shareToFeed: true }, facebook: { title: "" } }
    },
    account: metaAccount(item),
    token: credentials.accessToken,
    mediaUrl,
    mediaUrls,
    platform: target.platform,
    platformState: state,
    checkpoint
  });
}

export async function dispatchTarget(context) {
  await verifyMediaAssets(context.r2Credentials, context.item, context.target, context.state);
  const platform = context.target.platform;
  if (platform === "instagram" || platform === "facebook") return publishMeta(context);
  if (platform === "youtube") return publishYouTube({ ...context, credentials: youtubeCredentials(context.item) });
  if (platform === "tiktok") return publishTikTok({ ...context, credentials: tiktokCredentials(context.item) });
  throw new QaBlockedError("Unbekannter Publishing-Provider.", { platform, code: "PLATFORM_UNSUPPORTED" });
}

export async function verifyMediaAssets(credentials, item, target, state = {}) {
  const assets = (Array.isArray(item.media?.slides) ? item.media.slides : [item.media]).map((asset) => ({
    asset,
    invalidCode: "R2_MEDIA_INVALID",
    mismatchCode: "R2_MEDIA_MISMATCH",
    label: "Medium"
  }));
  if (target?.platform === "youtube") {
    const expectedHash = String(target.options?.thumbnail?.sha256 ?? "").toLowerCase();
    const confirmed = (state.thumbnailPhase === "CONFIRMED" || state.thumbnailSet === true)
      && String(state.thumbnailSha256 ?? "").toLowerCase() === expectedHash
      && expectedHash !== "";
    if (!confirmed) assets.push({
      asset: item.youtubeThumbnail,
      invalidCode: "YOUTUBE_THUMBNAIL_INVALID",
      mismatchCode: "YOUTUBE_THUMBNAIL_MISMATCH",
      label: "YouTube-Thumbnail"
    });
  }
  for (const { asset, invalidCode, mismatchCode, label } of assets) {
    if (!asset?.objectKey || !asset.sha256 || !Number.isSafeInteger(Number(asset.bytes))) {
      throw new QaBlockedError(`${label}daten in der Queue sind unvollstaendig.`, { code: invalidCode });
    }
    const remote = await headObject(credentials, asset.objectKey);
    if (!remote.exists || remote.sha256 !== asset.sha256 || remote.bytes !== Number(asset.bytes)) {
      throw new QaBlockedError(`R2-${label} stimmt nicht mit dem QA-gebundenen Asset ueberein.`, { code: mismatchCode, objectKey: asset.objectKey });
    }
  }
}
