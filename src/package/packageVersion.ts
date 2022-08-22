/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import * as os from 'os';
import {
  Connection,
  Lifecycle,
  Messages,
  NamedPackageDir,
  PollingClient,
  SfError,
  SfProject,
  StatusResult,
} from '@salesforce/core';
import { Duration } from '@salesforce/kit';
import {
  PackageSaveResult,
  PackageVersionCreateOptions,
  PackageVersionCreateRequestResult,
  PackageVersionOptions,
  PackageVersionReportResult,
  PackagingSObjects,
} from '../interfaces';
import {
  applyErrorAction,
  BY_LABEL,
  combineSaveErrors,
  generatePackageAliasEntry,
  getConfigPackageDirectory,
  getPackageAliasesFromId,
  getPackageIdFromAlias,
  getPackageVersionId,
  getSubscriberPackageVersionId,
  validateId,
} from '../utils';
import { PackageVersionCreate } from './packageVersionCreate';
import { getPackageVersionReport } from './packageVersionReport';
import { getCreatePackageVersionCreateRequestReport } from './packageVersionCreateRequestReport';
import { Package } from './package';

Messages.importMessagesDirectory(__dirname);

export class PackageVersion {
  private readonly project: SfProject;
  private readonly connection: Connection;

  public constructor(private options: PackageVersionOptions) {
    this.connection = this.options.connection;
    this.project = this.options.project;
  }

  /**
   * Creates a new package version.
   *
   * @param options
   * @param polling frequency and timeout Durations to be used in polling
   */
  public async create(
    options: PackageVersionCreateOptions,
    polling: { frequency: Duration; timeout: Duration } = {
      frequency: Duration.seconds(0),
      timeout: Duration.seconds(0),
    }
  ): Promise<Partial<PackageVersionCreateRequestResult>> {
    const pvc = new PackageVersionCreate({ ...options, ...this.options });
    const createResult = await pvc.createPackageVersion();

    return await this.waitForCreateVersion(createResult.Id, polling).catch((err: Error) => {
      // TODO
      // until package2 is GA, wrap perm-based errors w/ 'contact sfdc' action (REMOVE once package2 is GA'd)
      throw applyErrorAction(err);
    });
  }

  /**
   * Deletes a package version.
   *
   * @param idOrAlias
   */
  public async delete(idOrAlias: string): Promise<PackageSaveResult> {
    return this.updateDeprecation(idOrAlias, true);
  }

  /**
   * Undeletes a package version.
   *
   * @param idOrAlias
   */
  public async undelete(idOrAlias: string): Promise<PackageSaveResult> {
    return this.updateDeprecation(idOrAlias, false);
  }

  /**
   * Gets the package version report.
   *
   * @param createPackageRequestId
   * @param verbose
   */
  public async report(createPackageRequestId: string, verbose = false): Promise<PackageVersionReportResult> {
    const results = await getPackageVersionReport({
      idOrAlias: createPackageRequestId,
      connection: this.connection,
      project: this.project,
      verbose,
    }).catch((err: Error) => {
      // TODO
      // until package2 is GA, wrap perm-based errors w/ 'contact sfdc' action (REMOVE once package2 is GA'd)
      throw applyErrorAction(err);
    });
    return results[0];
  }

  /**
   * Gets current state of a package version create request.
   *
   * @param createPackageRequestId
   */
  public async getCreateVersionReport(createPackageRequestId: string): Promise<PackageVersionCreateRequestResult> {
    return await getCreatePackageVersionCreateRequestReport({
      createPackageVersionRequestId: createPackageRequestId,
      connection: this.connection,
    }).catch((err: Error) => {
      // TODO
      // until package2 is GA, wrap perm-based errors w/ 'contact sfdc' action (REMOVE once package2 is GA'd)
      throw applyErrorAction(err);
    });
  }

  /**
   * Convenience function that will wait for a package version to be created.
   *
   * This function emits LifeCycle events, "enqueued", "in-progress", "success", "error" and "timed-out" to
   * progress and current status. Events also carry a payload of type PackageVersionCreateRequestResult.
   *
   * @param packageId - The package id to wait for
   * @param createPackageVersionRequestId
   * @param polling frequency and timeout Durations to be used in polling
   * */
  public async waitForCreateVersion(
    createPackageVersionRequestId: string,
    polling: { frequency: Duration; timeout: Duration }
  ): Promise<PackageVersionCreateRequestResult> {
    if (polling.timeout?.milliseconds <= 0) {
      return await this.getCreateVersionReport(createPackageVersionRequestId);
    }
    let remainingWaitTime: Duration = polling.timeout;
    let report: PackageVersionCreateRequestResult;
    const pollingClient = await PollingClient.create({
      poll: async (): Promise<StatusResult> => {
        report = await this.getCreateVersionReport(createPackageVersionRequestId);
        switch (report.Status) {
          case 'Queued':
            await Lifecycle.getInstance().emit('enqueued', { ...report, remainingWaitTime });
            remainingWaitTime = Duration.seconds(remainingWaitTime.seconds - polling.frequency.seconds);
            return {
              completed: false,
              payload: report,
            };
          case 'InProgress':
          case 'Initializing':
          case 'VerifyingFeaturesAndSettings':
          case 'VerifyingDependencies':
          case 'VerifyingMetadata':
          case 'FinalizingPackageVersion':
            await Lifecycle.getInstance().emit('in-progress', { ...report, remainingWaitTime });
            remainingWaitTime = Duration.seconds(remainingWaitTime.seconds - polling.frequency.seconds);
            return {
              completed: false,
              payload: report,
            };
          case 'Success':
            await this.updateProjectWithPackageVersion(this.project, report);
            await Lifecycle.getInstance().emit('success', report);
            if (!process.env.SFDX_PROJECT_AUTOUPDATE_DISABLE_FOR_PACKAGE_CREATE) {
              // get the newly created package version from the server
              const versionResult = (
                await this.connection.tooling.query<{
                  Branch: string;
                  MajorVersion: string;
                  MinorVersion: string;
                  PatchVersion: string;
                  BuildNumber: string;
                }>(
                  `SELECT Branch, MajorVersion, MinorVersion, PatchVersion, BuildNumber FROM Package2Version WHERE SubscriberPackageVersionId='${report.SubscriberPackageVersionId}'`
                )
              ).records[0];
              const version = `${getPackageAliasesFromId(report.Package2Id, this.project).join()}@${
                versionResult.MajorVersion ?? 0
              }.${versionResult.MinorVersion ?? 0}.${versionResult.PatchVersion ?? 0}`;
              const build = versionResult.BuildNumber ? `-${versionResult.BuildNumber}` : '';
              const branch = versionResult.Branch ? `-${versionResult.Branch}` : '';
              // set packageAliases entry '<package>@<major>.<minor>.<patch>-<build>-<branch>: <result.subscriberPackageVersionId>'
              this.project.getSfProjectJson().getContents().packageAliases[`${version}${build}${branch}`] =
                report.SubscriberPackageVersionId;
              await this.project.getSfProjectJson().write();
            }
            return { completed: true, payload: report };
          case 'Error':
            await Lifecycle.getInstance().emit('error', report);
            return { completed: true, payload: report };
        }
      },

      frequency: polling.frequency,
      timeout: polling.timeout,
    });
    try {
      return pollingClient.subscribe<PackageVersionCreateRequestResult>();
    } catch (err) {
      await Lifecycle.getInstance().emit('timed-out', report);
      throw applyErrorAction(err as Error);
    }
  }

  public convert(): Promise<void> {
    return Promise.resolve(undefined);
  }

  public install(): Promise<void> {
    return Promise.resolve(undefined);
  }

  public list(): Promise<void> {
    return Promise.resolve(undefined);
  }

  public uninstall(): Promise<void> {
    return Promise.resolve(undefined);
  }

  public async promote(id: string): Promise<PackageSaveResult> {
    // lookup the 05i ID, if needed
    if (id.startsWith('04t')) {
      id = await getPackageVersionId(id, this.connection);
    }
    const result = await this.options.connection.tooling.update('Package2Version', { IsReleased: true, Id: id });
    if (!result.success) {
      throw SfError.wrap(result.errors.join(os.EOL));
    }
    return result;
  }

  public update(): Promise<void> {
    return Promise.resolve(undefined);
  }

  private async updateDeprecation(idOrAlias: string, IsDeprecated): Promise<PackageSaveResult> {
    const packageVersionId = getPackageIdFromAlias(idOrAlias, this.project);

    // ID can be an 04t or 05i
    validateId([BY_LABEL.SUBSCRIBER_PACKAGE_VERSION_ID, BY_LABEL.PACKAGE_VERSION_ID], packageVersionId);

    // lookup the 05i ID, if needed
    const packageId = await getPackageVersionId(packageVersionId, this.connection);

    // setup the request
    const request: { Id: string; IsDeprecated: boolean } = {
      Id: packageId,
      IsDeprecated,
    };

    const updateResult = await this.connection.tooling.update('Package2Version', request);
    if (!updateResult.success) {
      throw combineSaveErrors('Package2', 'update', updateResult.errors);
    }
    updateResult.id = await getSubscriberPackageVersionId(packageVersionId, this.connection);
    return updateResult;
  }

  private async updateProjectWithPackageVersion(
    withProject: SfProject,
    results: PackageVersionCreateRequestResult
  ): Promise<void> {
    if (withProject && !process.env.SFDX_PROJECT_AUTOUPDATE_DISABLE_FOR_PACKAGE_VERSION_CREATE) {
      const query = `SELECT Name, Package2Id, MajorVersion, MinorVersion, PatchVersion, BuildNumber, Description, Branch FROM Package2Version WHERE Id = '${results.Package2VersionId}'`;
      const packageVersion = await this.connection.singleRecordQuery<PackagingSObjects.Package2Version>(query, {
        tooling: true,
      });
      const packageVersionVersionString = `${packageVersion.MajorVersion}.${packageVersion.MinorVersion}.${packageVersion.PatchVersion}.${packageVersion.BuildNumber}`;
      await this.generatePackageDirectory(packageVersion, withProject, packageVersionVersionString);
      const newConfig = await generatePackageAliasEntry(
        this.connection,
        withProject,
        packageVersion.SubscriberPackageVersionId,
        packageVersionVersionString,
        packageVersion.Branch,
        packageVersion.Package2Id
      );
      withProject.getSfProjectJson().set('packageAliases', newConfig);
      await withProject.getSfProjectJson().write();
    }
  }

  private async generatePackageDirectory(
    packageVersion: PackagingSObjects.Package2Version,
    withProject: SfProject,
    packageVersionVersionString: string
  ): Promise<void> {
    const pkg = await (await Package.create({ connection: this.connection })).getPackage(packageVersion.Package2Id);
    const pkgDir =
      getConfigPackageDirectory(withProject.getPackageDirectories(), 'id', pkg.Id) ?? ({} as NamedPackageDir);
    pkgDir.versionNumber = packageVersionVersionString;
    pkgDir.versionDescription = packageVersion.Description;
    const packageDirs = withProject.getPackageDirectories().map((pd) => (pkgDir['id'] === pd['id'] ? pkgDir : pd));
    withProject.getSfProjectJson().set('packageDirectories', packageDirs);
  }
}
