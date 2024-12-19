import yargs from "https://deno.land/x/yargs@v17.7.2-deno/deno.ts";
import {
  buildPatch,
  buildRules,
  consoleLogger,
  getJson,
  ldAPIPatchRequest,
  ldAPIPostRequest,
  rateLimitRequest,
} from "./utils.ts";
import * as Colors from "https://deno.land/std@0.224.0/fmt/colors.ts";

interface Arguments {
  projKeySource: string[];
  projKeyDest: string;
  apikey: string;
  domain: string;
  allProjects: boolean;
  verbose: boolean;
  appendToNameAndKey: string;
}

console.time("Migration Completed");

const inputArgs: Arguments = yargs(Deno.args)
  .options({
    a: { type: "boolean", alias: "allProjects" },
    d: { type: "string", alias: "projKeyDest" },
    k: { type: "string", alias: "apikey" },
    p: { type: "array", alias: "projKeySource" },
    u: { type: "string", alias: "domain", default: "app.launchdarkly.com" },
    v: { type: "boolean", alias: "verbose" },
    n: { type: "string", alias: "appendToNameAndKey" },
  })
  .parse();

if (inputArgs.verbose) {
  console.log(inputArgs);
}

const projectList = await getAllProjects();

if (inputArgs.verbose) {
  console.log(projectList);
}

let projectCompletionCount = 0;
for (const project of projectList) {
  await migrateProject(project);
}

console.timeEnd("Migration Completed");
console.log(`Projects Migrated: ${projectCompletionCount}`);

async function getAllProjects() {
  const projectList = [];
  if (inputArgs.allProjects) {
    for await (const item of Deno.readDir("./source/project")) {
      if (item.isDirectory) {
        projectList.push(item.name);
      }
    }
  }

  return projectList;
}

async function migrateProject(projectKeySource: string) {
  const destProjectKey = inputArgs.appendToNameAndKey
    ? `${projectKeySource}-${inputArgs.appendToNameAndKey}`
    : projectKeySource;

  // Project Data //
  const projectJson = await getJson(
    `./source/project/${projectKeySource}/project.json`
  );

  const buildEnv: Array<any> = [];

  projectJson.environments.items.forEach((env: any) => {
    const newEnv: any = {
      name: env.name,
      key: env.key,
      color: env.color,
    };

    if (env.defaultTtl) newEnv.defaultTtl = env.defaultTtl;
    if (env.confirmChanges) newEnv.confirmChanges = env.confirmChanges;
    if (env.secureMode) newEnv.secureMode = env.secureMode;
    if (env.defaultTrackEvents)
      newEnv.defaultTrackEvents = env.defaultTrackEvents;
    if (env.tags) newEnv.tags = env.tags;

    buildEnv.push(newEnv);
  });

  const envkeys: Array<string> = buildEnv.map((env: any) => env.key);

  const projRep = projectJson; //as Project
  const projPost: any = {
    key: destProjectKey,
    name: inputArgs.appendToNameAndKey
      ? `${projRep.name} ${inputArgs.appendToNameAndKey}`
      : projRep.name, // Optional TODO: convert the target project key to a human-friendly project name
    tags: projRep.tags,
    environments: buildEnv,
  }; //as ProjectPost

  if (projRep.defaultClientSideAvailability) {
    projPost.defaultClientSideAvailability =
      projRep.defaultClientSideAvailability;
  } else {
    projPost.includeInSnippetByDefault = projRep.includeInSnippetByDefault;
  }

  const projResp = await rateLimitRequest(
    ldAPIPostRequest(inputArgs.apikey, inputArgs.domain, `projects`, projPost),
    "projects"
  );

  consoleLogger(
    projResp.status,
    `Creating Project: ${destProjectKey} Status: ${projResp.status}`
  );
  await projResp.json();

  for (const env of projRep.environments.items) {
    const segmentData = await getJson(
      `./source/project/${projectKeySource}/segment-${env.key}.json`
    );

    // We are ignoring big segments/synced segments for now
    for (const segment of segmentData.items) {
      if (segment.unbounded == true) {
        console.log(
          Colors.yellow(
            `Segment: ${segment.key} in Environment ${env.key} is unbounded, skipping`
          )
        );
        continue;
      }

      const newSegment: any = {
        name: segment.name,
        key: segment.key,
      };

      if (segment.tags) newSegment.tags = segment.tags;
      if (segment.description) newSegment.description = segment.description;

      const post = ldAPIPostRequest(
        inputArgs.apikey,
        inputArgs.domain,
        `segments/${destProjectKey}/${env.key}`,
        newSegment
      );

      const segmentResp = await rateLimitRequest(post,);

      const segmentStatus = await segmentResp.status;
      consoleLogger(
        segmentStatus,
        `[[ ${projectKeySource} ]]Creating segment ${newSegment.key} status: ${segmentStatus}`
      );
      if (segmentStatus > 201) {
        console.log(JSON.stringify(newSegment));
      }

      // Build Segment Patches //
      const sgmtPatches = [];

      if (segment.included?.length > 0) {
        sgmtPatches.push(buildPatch("included", "add", segment.included));
      }
      if (segment.excluded?.length > 0) {
        sgmtPatches.push(buildPatch("excluded", "add", segment.excluded));
      }

      if (segment.rules?.length > 0) {
        console.log(
          `[[ ${projectKeySource} ]] Copying Segment: ${segment.key} rules`
        );
        sgmtPatches.push(...buildRules(segment.rules));
      }

      const patchRules = await rateLimitRequest(
        ldAPIPatchRequest(
          inputArgs.apikey,
          inputArgs.domain,
          `segments/${destProjectKey}/${env.key}/${newSegment.key}`,
          sgmtPatches
        )
      );

      const segPatchStatus = patchRules.statusText;
      consoleLogger(
        patchRules.status,
        `[[ ${projectKeySource} ]] Patching segment ${newSegment.key} status: ${segPatchStatus}`
      );
    }
  }

  // Flag Data //
  const flagList: Array<string> = await getJson(
    `./source/project/${projectKeySource}/flags.json`
  );

  const flagsDoubleCheck: string[] = [];

  // Creating Global Flags //
  for (const [index, flagkey] of flagList.entries()) {
    // Read flag
    console.log(
      `[[ ${projectKeySource} ]] Reading flag ${index + 1} of ${
        flagList.length
      } : ${flagkey}`
    );

    const flag = await getJson(
      `./source/project/${projectKeySource}/flags/${flagkey}.json`
    );

    const newVariations = flag.variations.map(({ _id, ...rest }) => rest);

    const newFlag: any = {
      key: flag.key,
      name: flag.name,
      variations: newVariations,
      temporary: flag.temporary,
      tags: flag.tags,
      description: flag.description,
    };

    if (flag.clientSideAvailability) {
      newFlag.clientSideAvailability = flag.clientSideAvailability;
    } else if (flag.includeInSnippet) {
      newFlag.includeInSnippet = flag.includeInSnippet;
    }
    if (flag.customProperties) {
      newFlag.customProperties = flag.customProperties;
    }

    if (flag.defaults) {
      newFlag.defaults = flag.defaults;
    }

    console.log(
      `[[ ${projectKeySource} ]] \tCreating flag: ${flag.key} in Project: ${projectKeySource}`
    );
    const flagResp = await rateLimitRequest(
      ldAPIPostRequest(
        inputArgs.apikey,
        inputArgs.domain,
        `flags/${destProjectKey}`,
        newFlag
      )
    );
    if (flagResp.status == 200 || flagResp.status == 201) {
      console.log(`[[ ${projectKeySource} ]] \tFlag created`);
    } else {
      console.log(
        `[[ ${projectKeySource} ]] Error for flag ${newFlag.key}: ${flagResp.status}`
      );
    }

    // Add flag env settings
    for (const env of envkeys) {
      const patchReq: any[] = [];
      const flagEnvData = flag.environments[env];
      const parsedData: Record<string, string> = Object.keys(flagEnvData)
        .filter((key) => !key.includes("salt"))
        .filter((key) => !key.includes("version"))
        .filter((key) => !key.includes("lastModified"))
        .filter((key) => !key.includes("_environmentName"))
        .filter((key) => !key.includes("_site"))
        .filter((key) => !key.includes("_summary"))
        .filter((key) => !key.includes("sel"))
        .filter((key) => !key.includes("access"))
        .filter((key) => !key.includes("_debugEventsUntilDate"))
        .filter((key) => !key.startsWith("_"))
        .filter((key) => !key.startsWith("-"))
        .reduce((cur, key) => {
          return Object.assign(cur, { [key]: flagEnvData[key] });
        }, {});

      Object.keys(parsedData).map((key) => {
        if (key == "rules") {
          patchReq.push(...buildRules(parsedData[key], "environments/" + env));
        } else {
          patchReq.push(
            buildPatch(`environments/${env}/${key}`, "replace", parsedData[key])
          );
        }
      });
      await makePatchCall(flag.key, patchReq, env);

      console.log(
        `[[ ${projectKeySource} ]] \tFinished patching flag ${flagkey} for env ${env}`
      );
    }
  }

  // Send one patch per Flag for all Environments //
  const envList: string[] = [];
  projectJson.environments.items.forEach((env: any) => {
    envList.push(env.key);
  });

  // The # of patch calls is the # of environments * flags,
  // if you need to limit run time, a good place to start is to only patch the critical environments in a shorter list
  //const envList: string[] = ["test"];

  async function makePatchCall(flagKey, patchReq, env) {
    const patchFlagReq = await rateLimitRequest(
      ldAPIPatchRequest(
        inputArgs.apikey,
        inputArgs.domain,
        `flags/${destProjectKey}/${flagKey}`,
        patchReq
      )
    );
    const flagPatchStatus = await patchFlagReq.status;
    if (flagPatchStatus > 200) {
      flagsDoubleCheck.push(flagKey);
      consoleLogger(
        flagPatchStatus,
        `[[ ${projectKeySource} ]] \tPatching ${flagKey} with environment [${env}] specific configuration, Status: ${flagPatchStatus}`
      );
    }

    if (flagPatchStatus == 400) {
      console.log(patchFlagReq);
    }

    consoleLogger(
      flagPatchStatus,
      `[[ ${projectKeySource} ]] \tPatching ${flagKey} with environment [${env}] specific configuration, Status: ${flagPatchStatus}`
    );

    return flagsDoubleCheck;
  }

  if (flagsDoubleCheck.length > 0) {
    console.log(
      `[[ ${projectKeySource} ]] There are a few flags to double check as they have had an error or warning on the patch`
    );
    flagsDoubleCheck.forEach((flag) => {
      console.log(`[[ ${projectKeySource} ]] - ${flag}`);
    });
  }
  projectCompletionCount++;
}
