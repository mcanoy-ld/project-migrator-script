// deno-lint-ignore-file no-explicit-any
import yargs from "https://deno.land/x/yargs@v17.7.2-deno/deno.ts";
import {
  consoleLogger,
  delay,
  ldAPIRequest,
  writeSourceData,
} from "./utils.ts";
import { ensureDirSync } from "https://deno.land/std@0.149.0/fs/mod.ts";

interface Arguments {
  projKey: string;
  projKeyDest: string;
  apikey: string;
  domain: string;
  allProjects: boolean;
  verbose: boolean;
}

const inputArgs: Arguments = yargs(Deno.args)
  .options({
    a: { type: "boolean", alias: "allProjects" },
    k: { type: "string", alias: "apikey" },
    p: { type: "array", alias: "projKey" },
    u: { type: "string", alias: "domain", default: "app.launchdarkly.com" },
    v: { type: "boolean", alias: "verbose" },
  })
  .parse();

if (inputArgs.verbose) {
  console.log(inputArgs);
}

const projectItems: string[] = [];

// Project Data //
if (inputArgs.allProjects) {
  const projResp = await fetch(
    ldAPIRequest(inputArgs.apikey, inputArgs.domain, `projects`)
  );

  if (projResp == null) {
    console.log("Failed getting projects");
    Deno.exit(1);
  }

  const projData = await projResp.json();
  if (projData.code == "unauthorized") {
    console.log(`Unauthorized`);
    console.log(projData);
    Deno.exit(1);
  }

  projectItems.push(...projData.items.map((proj: { key: any }) => proj.key));
} else {
  projectItems.push(inputArgs.projKey);
}

projectItems.forEach((proj) => {
  getProjectData(proj);
});

async function getProjectData(proj: string) {
  const projPath = `./source/project/${proj}`;
  ensureDirSync(projPath);

  const projResp = await fetch(
    ldAPIRequest(
      inputArgs.apikey,
      inputArgs.domain,
      `projects/${proj}?expand=environments`
    )
  );
  if (projResp == null) {
    console.log("Failed getting project");
    Deno.exit(1);
  }
  const projData = await projResp.json();
  if (projData.message && projData.message.startsWith("Unknown project key")) {
    console.log(projData.message);
    Deno.exit(1);
  }
  await writeSourceData(projPath, "project", projData);
  await getAndWriteSegmentData(projData, projPath);

  console.timeEnd("Sourced Projects");
}

async function getAndWriteSegmentData(
  projData: { environments: { items: any[] }; key: any },
  projPath: string
) {
  if (projData.environments.items.length > 0) {
    console.log(
      `[[ ${projData.key} ]] Found ${projData.environments.items.length} environments`
    );

    projData.environments.items.forEach(async (env: any) => {
      console.log(
        `[[ ${projData.key} ]] Getting Segments for environment: ${env.key}`
      );

      const segmentResp = await fetch(
        ldAPIRequest(
          inputArgs.apikey,
          inputArgs.domain,
          `segments/${projData.key}/${env.key}`
        )
      );
      if (segmentResp == null) {
        console.log("Failed getting Segments");
        Deno.exit(1);
      }
      const segmentData = await segmentResp.json();

      await writeSourceData(projPath, `segment-${env.key}`, segmentData);
      const end = Date.now() + 2_000;
      while (Date.now() < end);
    });
  }
  await getAndWriteFlagData(projData, projPath);
}

async function getAndWriteFlagData(
  projData: { environments?: { items: any[] }; key: string },
  projPath: string
) {
  // Get List of all Flags
  const pageSize: number = 5;
  let offset: number = 0;
  let moreFlags: boolean = true;
  const flags: string[] = [];
  let path = `flags/${projData.key}?summary=true&limit=${pageSize}&offset=${offset}`;

  while (moreFlags) {
    console.log(
      `[[ ${projData.key} ]] Building flag list: ${offset} to ${
        offset + pageSize
      }`
    );

    console.log(`[[ ${projData.key} ]] ${path}`);
    const flagsResp = await fetch(
      ldAPIRequest(inputArgs.apikey, inputArgs.domain, path)
    );

    if (flagsResp.status > 201) {
      consoleLogger(
        flagsResp.status,
        `[[ ${projData.key} ]] Error getting flags: ${flagsResp.status}`
      );
      consoleLogger(flagsResp.status, await flagsResp.text());
    }
    if (flagsResp == null) {
      console.log("Failed getting Flags");
      Deno.exit(1);
    }

    const flagsData = await flagsResp.json();

    flags.push(...flagsData.items.map((flag: any) => flag.key));

    if (flagsData._links.next) {
      offset += pageSize;
      path = `flags/${projData.key}?summary=true&limit=${pageSize}&offset=${offset}`;
    } else {
      moreFlags = false;
    }
  }

  console.log(`[[ ${projData.key} ]] Found ${flags.length} flags`);

  await writeSourceData(projPath, "flags", flags);

  // Get Individual Flag Data //
  ensureDirSync(`${projPath}/flags`);

  for (const [index, flagKey] of flags.entries()) {
    console.log(
      `[[ ${projData.key} ]] Getting flag ${index + 1} of ${
        flags.length
      }: ${flagKey}`
    );

    await delay(200);

    const flagResp = await fetch(
      ldAPIRequest(
        inputArgs.apikey,
        inputArgs.domain,
        `flags/${projData.key}/${flagKey}`
      )
    );
    if (flagResp.status > 201) {
      consoleLogger(
        flagResp.status,
        `[[ ${projData.key} ]] Error getting flag '${flagKey}': ${flagResp.status}`
      );
      consoleLogger(flagResp.status, await flagResp.text());
    }
    if (flagResp == null) {
      console.log("[[ ${projData.key} ]] Failed getting flag '${flagKey}'");
      Deno.exit(1);
    }

    const flagData = await flagResp.json();

    await writeSourceData(`${projPath}/flags`, flagKey, flagData);
  }
}
