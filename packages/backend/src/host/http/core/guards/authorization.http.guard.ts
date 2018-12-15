import { AuthorizationEntity } from '@nestjs-bff/global/lib/entities/authorization.entity';
import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { INestjsBffConfig } from '../../../../config/nestjs-bff.config';
import { AuthorizationTest } from '../../../../domain/authorization/authorization-tests/authorization-test.abstract';
import { OrganizationDomainRepoCache } from '../../../../domain/organization/repo/organization.domain.repo-cache';
import { AppSharedProviderTokens } from '../../../../shared/app/app.shared.constants';
import { CacheStore } from '../../../../shared/caching/cache-store.shared';
import { CachingProviderTokens } from '../../../../shared/caching/caching.shared.constants';
import { LoggerSharedService } from '../../../../shared/logging/logger.shared.service';
import { BadGatewayHttpError } from '../exceptions/server.http.exception';
import { getReqMetadataLite } from '../utils/core.http.utils';

/**
 *
 *
 * @summary
 *  Checks authorization against a configured authorizationtest
 *  Defaults false: no authorizationtest found means no authorization
 *  Looks for authorizationtest from handler - first on handler method, then on controller
 *
 * @export
 * @class ResourceGuard
 * @implements {CanActivate}
 */
@Injectable()
export class AuthorizationHttpGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly organizationCache: OrganizationDomainRepoCache,
    @Inject(CachingProviderTokens.Services.CacheStore)
    private readonly cacheStore: CacheStore,
    @Inject(AppSharedProviderTokens.Config.App)
    private readonly nestjsBffConfig: INestjsBffConfig,
    private readonly logger: LoggerSharedService,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      const req = context.switchToHttp().getRequest<any>();
      if (!req) throw new BadGatewayHttpError('request can not be null');

      this.logger.trace('AuthorizationGuard.canActivate', {
        'req.originalUrl': req.originalUrl,
      });

      // test to see if public route
      if (this.nestjsBffConfig.http.publicRouteRegex.test(req.originalUrl)) {
        this.logger.debug('Public Route', req.originalUrl);
        return true;
      }

      // get authorization from request
      const authorization = req.authorization as AuthorizationEntity;
      if (!authorization) {
        this.logger.warn('Route not public, but no authorization found. ', {
          request: getReqMetadataLite(req),
        });
        return false;
      }

      // debug logging
      this.logger.debug('AuthorizationGuard', {
        'req.params': req.params,
        'req.route': req.route,
        authorization,
      });

      // get key date for auth tests
      const organizationId = await this.getOrganizationIdFromSlug(req.params['organizationSlug']);
      const authorizationtests = await this.getauthorizationtestsFromCache(context);

      // Default false. No authorizationtest configured, not authorization
      if (!authorizationtests || authorizationtests.length === 0) {
        this.logger.warn('Request not authorized', {
          request: getReqMetadataLite(req),
          authorization,
        });
        return false;
      }

      // run tests
      for (const authorizationtest of authorizationtests) {
        if (!(await authorizationtest.isAuthorized(authorization, organizationId))) {
          this.logger.warn(`authorizationtest failed`, {
            authorization,
            organizationId,
          });
          return false;
        }
      }

      // if we made it here we passed all the tests.  return true
      this.logger.debug(`authorizationtest passed`, {
        authorization,
        organizationId,
      });
      return true;
    } catch (error) {
      this.logger.error('Error in ResourceGuard', error);
      return false;
    }
  }

  /**
   *
   * @param organizationSlug
   */
  private async getOrganizationIdFromSlug(organizationSlug: string): Promise<string | undefined> {
    if (!organizationSlug) {
      this.logger.debug('organizationSlug not found');
      return undefined;
    }

    this.logger.debug('organizationSlug found', organizationSlug);

    const organization = await this.organizationCache.findBySlug(organizationSlug);
    if (!organization) {
      this.logger.debug('organizationId not found for slug', organizationSlug);
      return undefined;
    }

    this.logger.debug('organizationId found for slug', {
      organizationSlug,
      organizationId: organization.id,
    });
    return organization.id;
  }

  private async getauthorizationtestsFromCache(context: ExecutionContext): Promise<AuthorizationTest[]> {
    const authorizationtestCacheKey = `AuthorizationGuard-authorizationtest?class=${context.getClass()}&handler=${context.getHandler()})`;

    return this.cacheStore.wrap<AuthorizationTest | AuthorizationTest[] | null>(
      authorizationtestCacheKey,
      () => this.getauthorizationtest(context),
      // This configuration does not change dynamically.  Cache for a week
      { ttl: 60 * 60 * 24 * 7 },
    );
  }

  private async getauthorizationtest(context: ExecutionContext): Promise<AuthorizationTest[]> {
    let authorizationtests = this.reflector.get<AuthorizationTest[]>('authorization', context.getHandler());
    if (!authorizationtests) {
      authorizationtests = this.reflector.get<AuthorizationTest[]>('authorization', context.getClass());
    }
    return authorizationtests;
  }
}
