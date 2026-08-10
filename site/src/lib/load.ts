import type { Recording } from "./recordings";

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
 * All sixteen supported ecosystems are here, including the ones whose
 * recordings are thin. A page that showed seven and said nothing about the
 * other nine was making a claim by omission — a Dart developer had no way to
 * learn Drift reads pubspec.yaml — and the thin recordings are informative in
 * their own right: an OCaml project whose dependencies are all open floors
 * genuinely has nothing to upgrade, and Drift saying so is the answer.
 *
 * `as unknown as Recording` is doing something narrow: the JSON's inferred
 * literal types are structurally compatible but far more specific than the
 * interface (every string becomes its own literal type), and widening them here
 * is what lets `recordings.ts` stay the single description of the shape.
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
  ] as unknown as Recording[];
}
