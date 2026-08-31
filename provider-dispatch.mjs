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
  await verifyMediaAssets(context.r2Credentials, context.item);
  const platform = context.target.platform;
  if (platform === "instagram" || platform === "facebook") return publishMeta(context);
  if (platform === "youtube") return publishYouTube({ ...context, credentials: youtubeCredentials(context.item) });
  if (platform === "tiktok") return publishTikTok({ ...context, credentials: tiktokCredentials(context.item) });
  throw new QaBlockedError("Unbekannter Publishing-Provider.", { platform, code: "PLATFORM_UNSUPPORTED" });
}

async function verifyMediaAssets(credentials, item) {
  const assets = Array.isArray(item.media?.slides) ? item.media.slides : [item.media];
  for (const asset of assets) {
    if (!asset?.objectKey || !asset.sha256 || !Number.isSafeInteger(Number(asset.bytes))) {
      throw new QaBlockedError("Queue-Mediendaten sind unvollstaendig.", { code: "R2_MEDIA_INVALID" });
    }
    const remote = await headObject(credentials, asset.objectKey);
    if (!remote.exists || remote.sha256 !== asset.sha256 || remote.bytes !== Number(asset.bytes)) {
      throw new QaBlockedError("R2-Medium stimmt nicht mit dem QA-gebundenen Asset ueberein.", { code: "R2_MEDIA_MISMATCH", objectKey: asset.objectKey });
    }
  }
}
