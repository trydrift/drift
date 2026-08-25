import { normalizeRecording, type Recording } from "./recordings";

import supabase from "@/data/supabase.json";
import scrapy from "@/data/scrapy.json";
import gitlab from "@/data/gitlab.json";
import kubernetes from "@/data/kubernetes.json";
import deno from "@/data/deno.json";
import elasticsearch from "@/data/elasticsearch.json";
import esphome from "@/data/esphome.json";
import restsharp from "@/data/restsharp.json";
import guzzle from "@/data/guzzle.json";
import phoenix from "@/data/phoenix.json";
import dio from "@/data/dio.json";
import tca from "@/data/tca.json";
import flexlayout from "@/data/flexlayout.json";
import cohttp from "@/data/cohttp.json";
import trantor from "@/data/trantor.json";
import obsBackgroundRemoval from "@/data/obs-backgroundremoval.json";

/**
 * Every recording, in the order the tabs show them.
 *
 * Imported statically rather than read from disk at request time — the site is
 * a static export, so there is no request time — and listed explicitly rather
 * than globbed, because the order is an editorial decision. TypeScript's most
 * common ecosystem goes first, and the ones with the most interesting findings
 * follow it, so a visitor who only plays one recording plays a good one.
 *
 * Every ecosystem whose artifact includes the extension's candidate lifecycle
 * is here. An obsolete recording is omitted rather than rendered as a
 * misleading compatibility view; the refresh workflow restores it after a
 * current capture is committed.
 *
 * JSON imports are intentionally treated as unknown at this boundary: the
 * schema check decides whether they are safe for the replay UI.
 */
export function loadRecordings(): Recording[] {
  return [
    supabase,
    scrapy,
    gitlab,
    kubernetes,
    deno,
    elasticsearch,
    esphome,
    phoenix,
    restsharp,
    guzzle,
    dio,
    trantor,
    obsBackgroundRemoval,
    flexlayout,
    tca,
    cohttp,
  ]
    .map(normalizeRecording)
    .filter((recording): recording is Recording => recording !== null);
}
