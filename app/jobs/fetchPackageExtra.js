/**
 * Fetch package extra data
 **/
const _ = require("lodash");

const config = require("config");
const urljoin = require("url-join");

const PackageExtra = require("../models/packageExtra");
const { getCachedAvatarImageFilename } = require("../common/utils");
const { createGqlClient, gitFileContentGql } = require("../utils/githubGql");
const {
  loadPackageNames,
  loadPackage,
  packageExists,
} = require("../utils/package");
const { renderMarkdownToHtml } = require("../utils/markdown");
const {
  AxiosService,
  CancelToken,
  httpErrorInfo,
  isErrorCode,
} = require("../utils/http");
const { addImage, getImage } = require("../utils/media");
const { healthCheck } = require("../utils/healthCheck");
const logger = require("../utils/log")(module);
const { getGithubToken } = require("../utils/github");

/**
 * Fetch package extra data into redis for given packageNames array.
 * @param {Array} packageNames
 * @param {Boolean} force
 */
const fetchExtraData = async function(packageNames, force) {
  logger.info("fetchExtraData");
  if (!packageNames) packageNames = [];
  for (let packageName of packageNames) {
    // Verify package
    if (!packageExists(packageName)) {
      logger.error({ pkg: packageName }, "package doesn't exist");
      continue;
    }
    // Load package
    const pkg = await loadPackage(packageName);
    await _fetchPackageInfo(packageName);
    await _fetchPackageScopes(packageName);
    await _fetchRepoInfo(pkg.repo, packageName);
    await _fetchReadme(pkg, packageName);
    await _cacheImage(pkg, packageName, force);
    await _cacheAvatarImage(pkg, packageName, force);
    await _fetchPackageInstallCount(packageName);
  }
};

/**
 * Fetch package meta json.
 * @param {string} packageName
 */
const fetchPackageMeta = async function(packageName) {
  let resp = null;
  const source = CancelToken.source();
  setTimeout(() => {
    if (resp === null) source.cancel("ECONNTIMEOUT");
  }, 10000);
  resp = await AxiosService.create().get(
    urljoin("https://package.openupm.com", packageName),
    {
      headers: { Accept: "application/json" },
      cancelToken: source.token,
    }
  );
  return resp.data;
};

// Get latest version from the package meta
const getLatestVersion = function(pkgMeta) {
  if (pkgMeta["dist-tags"] && pkgMeta["dist-tags"]["latest"])
    return pkgMeta["dist-tags"]["latest"];
  else if (pkgMeta.versions)
    return Object.keys(pkgMeta.versions).find(
      (key) => pkgMeta.versions[key] == "latest"
    );
};

/**
 * Fetch package info from the registry.
 * @param {string} packageName
 */
const _fetchPackageInfo = async function(packageName) {
  logger.info({ pkg: packageName }, "_fetchPackageInfo");
  try {
    const pkgMeta = await fetchPackageMeta(packageName);
    const version = pkgMeta["dist-tags"].latest;
    const versionInfo = pkgMeta.versions[version];
    // Save the unity version.
    const unityVersion = /^[0-9]{4,4}\.[0-9]/i.test(versionInfo.unity)
      ? versionInfo.unity
      : "";
    await PackageExtra.setUnityVersion(packageName, unityVersion);
    // Save the update time.
    const timeStr = pkgMeta.time[version] || 0;
    const time = new Date(timeStr).getTime();
    await PackageExtra.setUpdatedTime(packageName, time);
    // Save the package version.
    await PackageExtra.setVersion(packageName, version);
  } catch (error) {
    logger.error(
      httpErrorInfo(error, { pkg: packageName }),
      "fetch package info error"
    );
  }
};

/**
 * Fetch package scopes for dependencies.
 * @param {string} packageName
 */
const _fetchPackageScopes = async function(packageName) {
  logger.info({ pkg: packageName }, "_fetchPackageScopes");
  // a list of pending {name, version}
  const pendingList = [{ name: packageName, version: null }];
  // a list of processed {name, version}
  const processedList = [];
  // a set of package names exists on the registry
  const scopeSet = new Set();
  // cached package meta: { name: meta }
  const cachedPackageMetas = {};
  while (pendingList.length > 0) {
    const entry = pendingList.shift();
    if (processedList.find((x) => x.name === entry.name) === undefined) {
      // add entry to processed list
      processedList.push(entry);
      // skip unity module
      if (/com.unity.modules/i.test(entry.name)) continue;
      // fetch package meta from the cache
      let pkgMeta = cachedPackageMetas[entry.name];
      // fetch package meta from the registry
      if (!pkgMeta) {
        try {
          pkgMeta = await fetchPackageMeta(entry.name);
          cachedPackageMetas[entry.name] = pkgMeta;
        } catch (err) {
          if (!isErrorCode(err, 404)) {
            logger.error(
              httpErrorInfo(err, { pkg: packageName }),
              "fetch package scopes error"
            );
          }
        }
      }
      // skip unexisted package
      if (!pkgMeta) continue;
      // add to the scope list
      scopeSet.add(entry.name);
      // parse the latest version
      if (!entry.version || entry.version == "latest")
        entry.version = getLatestVersion(pkgMeta);
      // fall back to latest version if version does not existed
      const versions = Object.keys(pkgMeta.versions);
      if (!versions.find((x) => x == entry.version))
        entry.version = getLatestVersion(pkgMeta);
      try {
        // add dependencies to pending list
        const deps = _.toPairs(
          pkgMeta.versions[entry.version]["dependencies"]
        ).map((x) => {
          return { name: x[0], version: x[1] };
        });
        deps.forEach((x) => pendingList.push(x));
      } catch (err) {
        logger.error(
          httpErrorInfo(err, { pkg: packageName, dep: entry.name }),
          "fetch package scopes error"
        );
      }
    }
  }
  // Save to db.
  const scopes = Array.from(scopeSet);
  scopes.sort();
  await PackageExtra.setScopes(packageName, scopes);
};

/**
 * Fetch repository information like stars and pushed time.
 * @param {object} repo
 */
const _fetchRepoInfo = async function(repo, packageName) {
  logger.info({ pkg: packageName }, "_fetchRepoInfo");
  try {
    const headers = { Accept: "application/vnd.github.v3.json" };
    const githubToken = getGithubToken();
    if (githubToken) headers.authorization = `Bearer ${githubToken}`;
    let resp = null;
    const source = CancelToken.source();
    setTimeout(() => {
      if (resp === null) source.cancel("ECONNTIMEOUT");
    }, 10000);
    resp = await AxiosService.create().get(
      urljoin("https://api.github.com/repos/", repo),
      { headers, cancelToken: source.token }
    );
    const repoInfo = resp.data;
    const stars = repoInfo.stargazers_count || 0;
    await PackageExtra.setStars(packageName, stars);
    if (repoInfo.parent) {
      const pstars = repoInfo.parent.stargazers_count || 0;
      await PackageExtra.setParentStars(packageName, pstars);
    }
    if (repoInfo.pushed_at) {
      const time = new Date(repoInfo.pushed_at).getTime();
      await PackageExtra.setRepoPushedTime(packageName, time);
    }
    if (repoInfo.updated_at) {
      const time = new Date(repoInfo.updated_at).getTime();
      await PackageExtra.setRepoUpdatedTime(packageName, time);
    }
  } catch (error) {
    logger.error(
      httpErrorInfo(error, { pkg: packageName }),
      "fetch stars error"
    );
  }
};

/**
 * Cache the image url
 * @param {object} pkg
 * @param {string} packageName
 * @param {Boolean} force
 */
const _cacheImage = async function(pkg, packageName, force) {
  logger.info({ pkg: packageName }, "_cacheImage");
  try {
    const query = await PackageExtra.getImageQueryForPackage(packageName);
    if (!query) return;

    // check cache
    let imageEntry = await getImage(query);
    if (!force && imageEntry && imageEntry.available) {
      logger.info({ pkg: packageName }, "_cacheImage cache is available");
      return;
    }

    // add image
    const duration = config.packageExtra.image.duration;
    await addImage({
      ...query,
      duration,
      force,
    });
  } catch (error) {
    logger.error(
      httpErrorInfo(error, { pkg: packageName }),
      "_cacheImage error"
    );
  }
};

/**
 * Cache the avatar image url
 * @param {object} pkg
 * @param {string} packageName
 * @param {Boolean} force
 */
const _cacheAvatarImage = async function(pkg, packageName, force) {
  logger.info({ pkg: packageName }, "_cacheAvatarImage");
  if (pkg.owner) await cacheAvatarImageForGithubUser(pkg.owner, force);
  if (pkg.parentOwner)
    await cacheAvatarImageForGithubUser(pkg.parentOwner, force);
  if (pkg.hunter) await cacheAvatarImageForGithubUser(pkg.hunter, force);
};

/**
 * Cache the avatar image url for the GitHub user
 * @param {string} username
 * @param {Boolean} force
 */
const cacheAvatarImageForGithubUser = async function(username, force) {
  for (const [sizeName, entry] of Object.entries(config.packageExtra.avatar)) {
    logger.info(
      { username, width: entry.size, height: entry.size, sizeName },
      "cacheAvatarImageForGithubUser"
    );
    try {
      const query = await PackageExtra.getImageQueryForGithubUser(
        username,
        entry.size
      );
      if (!query) return;

      // check cache
      let imageEntry = await getImage(query);
      if (!force && imageEntry && imageEntry.available) {
        logger.info(
          { username, width: entry.size, height: entry.size, sizeName },
          "cacheAvatarImageForGithubUser cache is available"
        );
        return;
      }

      // add image
      const duration = entry.duration;
      // override default image filename
      const filename = getCachedAvatarImageFilename(username, entry.size);
      await addImage({
        ...query,
        duration,
        filename,
        force,
      });
    } catch (error) {
      logger.error(
        httpErrorInfo(error, { username }),
        "cacheAvatarImageForGithubUser error"
      );
    }
  }
};

/**
 * Fetch repository readme.
 * @param {object} repo
 */
const _fetchReadme = async function(pkg, packageName) {
  logger.info({ pkg: packageName }, "_fetchReadme");
  const langs = ["en-US", "zh-CN"];
  for (const lang of langs) {
    const readmePathPropKey = PackageExtra.getPropKeyForLang(
      PackageExtra.propKeys.readme,
      lang
    );
    const readmePath = pkg[readmePathPropKey];
    if (readmePath)
      await _fetchReadmeForLang(pkg, packageName, lang, readmePath);
  }
};

const _fetchReadmeForLang = async function(pkg, packageName, lang, readmePath) {
  logger.info({ pkg: packageName, lang, readmePath }, "_fetchReadmeForLang");
  const pushedTime = await PackageExtra.getRepoPushedTime(packageName);
  const readmeCacheKey = `v0:${readmePath}:${pushedTime}`;
  const prevReadmeCacheKey = await PackageExtra.getReadmeCacheKey(
    packageName,
    lang
  );
  if (readmeCacheKey == prevReadmeCacheKey) {
    logger.info(
      { pkg: packageName, lang, readmePath },
      "skip _fetchReadmeForLang because the cache is available"
    );
    return;
  }
  try {
    const [owner, name] = pkg.repo.split("/");
    const data = await createGqlClient().request(gitFileContentGql, {
      owner,
      name,
      tree: readmePath,
    });
    let text = "";
    if (data.repository.tree && data.repository.tree.text)
      text = data.repository.tree.text;
    await PackageExtra.setReadme(packageName, text, lang);
    const html = await renderMarkdownToHtml({ pkg, markdown: text });
    await PackageExtra.setReadmeHtml(packageName, html, lang);
    await PackageExtra.setReadmeCacheKey(packageName, lang, readmeCacheKey);
  } catch (error) {
    logger.error(
      { err: error, pkg: packageName, lang, readmePath },
      "_fetchReadmeForLang"
    );
  }
};

/**
 * Fetch package meta json.
 * @param {string} packageName
 * @returns {Number}
 */
const fetchPackageMonthlyInstallCount = async function(packageName) {
  let resp = null;
  const source = CancelToken.source();
  setTimeout(() => {
    if (resp === null) source.cancel("ECONNTIMEOUT");
  }, 10000);
  resp = await AxiosService.create().get(
    urljoin(
      "https://package.openupm.com/downloads/point/last-month",
      packageName
    ),
    {
      headers: { Accept: "application/json" },
      cancelToken: source.token,
    }
  );
  return resp.data;
};

/**
 * Fetch package install count.
 * @param {string} packageName
 */
const _fetchPackageInstallCount = async function(packageName) {
  logger.info({ pkg: packageName }, "_fetchPackageInstallCount");
  try {
    const result = await fetchPackageMonthlyInstallCount(packageName);
    const count = result.downloads || 0;
    await PackageExtra.setMonthlyDownloads(packageName, count);
  } catch (error) {
    logger.error(
      httpErrorInfo(error, { pkg: packageName }),
      "fetch package install count error"
    );
  }
};

module.exports = { cacheAvatarImageForGithubUser };

if (require.main === module) {
  let program = require("../utils/commander");
  let packageNames = null;
  program
    .option("--all", "fetch extra package data for all packages")
    .option("-f, --force", "ignore cache and force to fetch stuffs")
    .arguments("[name...]")
    .action(function(names) {
      packageNames = names;
    })
    .parse(process.argv)
    .run(async function() {
      if (program.all)
        packageNames = await loadPackageNames({ sortKey: "-mtime" });
      if (packageNames === null || !packageNames.length) program.help();
      await fetchExtraData(packageNames, program.force);
      await healthCheck(config.healthCheck.ids.fetchPackageExtra);
    });
}
