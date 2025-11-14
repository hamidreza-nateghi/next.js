import type { LoaderTree } from '../../server/lib/app-dir-module'
import type { Params } from '../../server/request/params'
import type { AppPageRouteModule } from '../../server/route-modules/app-page/module.compiled'
import type { AppRouteRouteModule } from '../../server/route-modules/app-route/module.compiled'
import { isAppPageRouteModule } from '../../server/route-modules/checks'
import type { DynamicParamTypes } from '../../shared/lib/app-router-types'
import { InvariantError } from '../../shared/lib/invariant-error'
import {
  parseAppRouteSegment,
  type NormalizedAppRoute,
  type NormalizedAppRouteSegment,
} from '../../shared/lib/router/routes/app'
import { parseLoaderTree } from '../../shared/lib/router/utils/parse-loader-tree'
import type { AppSegment } from '../segment-config/app/app-segments'
import type { FallbackRouteParam } from './types'

/**
 * Encodes a parameter value using the provided encoder.
 *
 * @param value - The value to encode.
 * @param encoder - The encoder to use.
 * @returns The encoded value.
 */
export function encodeParam(
  value: string | string[],
  encoder: (value: string) => string
) {
  let replaceValue: string
  if (Array.isArray(value)) {
    replaceValue = value.map(encoder).join('/')
  } else {
    replaceValue = encoder(value)
  }

  return replaceValue
}

/**
 * Normalizes a pathname to a consistent format.
 *
 * @param pathname - The pathname to normalize.
 * @returns The normalized pathname.
 */
export function normalizePathname(pathname: string) {
  return pathname.replace(/\\/g, '/').replace(/(?!^)\/$/, '')
}

export function interceptionPrefixFromParamType(
  paramType: DynamicParamTypes
): string | null {
  switch (paramType) {
    case 'catchall-intercepted-(..)(..)':
    case 'dynamic-intercepted-(..)(..)':
      return '(..)(..)'
    case 'catchall-intercepted-(.)':
    case 'dynamic-intercepted-(.)':
      return '(.)'
    case 'catchall-intercepted-(..)':
    case 'dynamic-intercepted-(..)':
      return '(..)'
    case 'catchall-intercepted-(...)':
    case 'dynamic-intercepted-(...)':
      return '(...)'
    case 'catchall':
    case 'dynamic':
    case 'optional-catchall':
    default:
      return null
  }
}

/**
 * Extracts the param value from a path segment, handling interception markers
 * based on the expected param type.
 *
 * @param pathSegment - The path segment to extract the value from
 * @param params - The current params object for resolving dynamic param references
 * @param paramType - The expected param type which may include interception marker info
 * @returns The extracted param value
 */
function getParamValueFromSegment(
  pathSegment: NormalizedAppRouteSegment,
  params: Params,
  paramType: DynamicParamTypes
): string {
  // If the segment is dynamic, resolve it from the params object
  if (pathSegment.type === 'dynamic') {
    return params[pathSegment.param.paramName] as string
  }

  // If the paramType indicates this is an intercepted param, strip the marker
  // that matches the interception marker in the param type
  const interceptionPrefix = interceptionPrefixFromParamType(paramType)
  if (interceptionPrefix === pathSegment.interceptionMarker) {
    return pathSegment.name.replace(pathSegment.interceptionMarker, '')
  }

  // For static segments, use the name
  return pathSegment.name
}

/**
 * Resolves a route parameter value from the route segments at the given depth.
 * This shared logic is used by both extractPathnameRouteParamSegmentsFromLoaderTree
 * and resolveRouteParamsFromTree.
 *
 * @param paramName - The parameter name to resolve
 * @param paramType - The parameter type (dynamic, catchall, etc.)
 * @param depth - The current depth in the route tree
 * @param route - The normalized route containing segments
 * @param params - The current params object (used to resolve embedded param references)
 * @param options - Configuration options
 * @returns The resolved parameter value, or undefined if it cannot be resolved
 */
export function resolveParamValue(
  paramName: string,
  paramType: DynamicParamTypes,
  depth: number,
  route: NormalizedAppRoute,
  params: Params
): string | string[] | undefined {
  switch (paramType) {
    case 'catchall':
    case 'optional-catchall':
    case 'catchall-intercepted-(..)(..)':
    case 'catchall-intercepted-(.)':
    case 'catchall-intercepted-(..)':
    case 'catchall-intercepted-(...)':
      // For catchall routes, derive from pathname using depth to determine
      // which segments to use
      const processedSegments: string[] = []

      // Process segments to handle any embedded dynamic params
      for (let index = depth; index < route.segments.length; index++) {
        const pathSegment = route.segments[index]

        if (pathSegment.type === 'static') {
          let value = pathSegment.name

          // For intercepted catch-all params, strip the marker from the first segment
          const interceptionPrefix = interceptionPrefixFromParamType(paramType)
          if (
            interceptionPrefix &&
            index === depth &&
            interceptionPrefix === pathSegment.interceptionMarker
          ) {
            // Strip the interception marker from the value
            value = value.replace(pathSegment.interceptionMarker, '')
          }

          processedSegments.push(value)
        } else {
          // If the segment is a param placeholder, check if we have its value
          if (!params.hasOwnProperty(pathSegment.param.paramName)) {
            // Unknown param placeholder in pathname - can't derive full value
            return undefined
          }

          // If the segment matches a param, use the param value
          // We don't encode values here as that's handled during retrieval.
          const paramValue = params[pathSegment.param.paramName]
          if (Array.isArray(paramValue)) {
            processedSegments.push(...paramValue)
          } else {
            processedSegments.push(paramValue as string)
          }
        }
      }

      if (processedSegments.length > 0 || paramType === 'optional-catchall') {
        return processedSegments
      } else {
        // We shouldn't be able to match a catchall segment without any path
        // segments if it's not an optional catchall
        throw new InvariantError(
          `Unexpected empty path segments match for a route "${route.pathname}" with param "${paramName}" of type "${paramType}"`
        )
      }
    case 'dynamic':
    case 'dynamic-intercepted-(..)(..)':
    case 'dynamic-intercepted-(.)':
    case 'dynamic-intercepted-(..)':
    case 'dynamic-intercepted-(...)':
      // For regular dynamic parameters, take the segment at this depth
      if (depth < route.segments.length) {
        const pathSegment = route.segments[depth]

        // Check if the segment at this depth is a placeholder for an unknown param
        if (
          pathSegment.type === 'dynamic' &&
          !params.hasOwnProperty(pathSegment.param.paramName)
        ) {
          // The segment is a placeholder like [category] and we don't have the value
          return undefined
        }

        // If the segment matches a param, use the param value from params object
        // Otherwise it's a static segment, just use it directly
        // We don't encode values here as that's handled during retrieval
        return getParamValueFromSegment(pathSegment, params, paramType)
      }

      return undefined

    default:
      paramType satisfies never
  }
}

/**
 * Validates that the static segments in currentPath match the corresponding
 * segments in targetSegments. This ensures we only extract dynamic parameters
 * that are part of the target pathname structure.
 *
 * Segments are compared literally - interception markers like "(.)photo" are
 * part of the pathname and must match exactly.
 *
 * @example
 * // Matching paths
 * currentPath: ['blog', '(.)photo']
 * targetSegments: ['blog', '(.)photo', '[id]']
 * → Returns true (both static segments match exactly)
 *
 * @example
 * // Non-matching paths
 * currentPath: ['blog', '(.)photo']
 * targetSegments: ['blog', 'photo', '[id]']
 * → Returns false (segments don't match - marker is part of pathname)
 *
 * @param currentPath - The accumulated path segments from the loader tree
 * @param targetSegments - The target pathname split into segments
 * @returns true if all static segments match, false otherwise
 */
function validatePrefixMatch(
  currentPath: NormalizedAppRouteSegment[],
  route: NormalizedAppRoute
): boolean {
  for (let i = 0; i < currentPath.length; i++) {
    const pathSegment = currentPath[i]
    const targetPathSegment = route.segments[i]

    // Type mismatch - one is static, one is dynamic
    if (pathSegment.type !== targetPathSegment.type) {
      return false
    }

    // One has an interception marker, the other doesn't.
    if (
      pathSegment.interceptionMarker !== targetPathSegment.interceptionMarker
    ) {
      return false
    }

    // Both are static but names don't match
    if (
      pathSegment.type === 'static' &&
      targetPathSegment.type === 'static' &&
      pathSegment.name !== targetPathSegment.name
    ) {
      return false
    }
    // Both are dynamic but param names don't match
    else if (
      pathSegment.type === 'dynamic' &&
      targetPathSegment.type === 'dynamic' &&
      pathSegment.param.paramType !== targetPathSegment.param.paramType &&
      pathSegment.param.paramName !== targetPathSegment.param.paramName
    ) {
      return false
    }
  }

  return true
}

/**
 * Extracts segments that contribute to the pathname by traversing the loader tree
 * based on the route module type.
 *
 * @param routeModule - The app route module (page or route handler)
 * @param segments - Array of AppSegment objects collected from the route
 * @param page - The target pathname to match against, INCLUDING interception
 *               markers (e.g., "/blog/[slug]", "/(.)photo/[id]")
 * @returns Array of segments with param info that contribute to the pathname
 */
export function extractPathnameRouteParamSegments(
  routeModule: AppRouteRouteModule | AppPageRouteModule,
  segments: readonly Readonly<AppSegment>[],
  route: NormalizedAppRoute
): Array<{
  readonly name: string
  readonly paramName: string
  readonly paramType: DynamicParamTypes
}> {
  // For AppPageRouteModule, use the loaderTree traversal approach
  if (isAppPageRouteModule(routeModule)) {
    const { pathnameRouteParamSegments } =
      extractPathnameRouteParamSegmentsFromLoaderTree(
        routeModule.userland.loaderTree,
        route
      )
    return pathnameRouteParamSegments
  }

  return extractPathnameRouteParamSegmentsFromSegments(segments)
}

export function extractPathnameRouteParamSegmentsFromSegments(
  segments: readonly Readonly<AppSegment>[]
): Array<{
  readonly name: string
  readonly paramName: string
  readonly paramType: DynamicParamTypes
}> {
  // TODO: should we consider what values are already present in the page?

  // For AppRouteRouteModule, filter the segments array to get the route params
  // that contribute to the pathname.
  const result: Array<{
    readonly name: string
    readonly paramName: string
    readonly paramType: DynamicParamTypes
  }> = []

  for (const segment of segments) {
    // Skip segments without param info.
    if (!segment.paramName || !segment.paramType) continue

    // Collect all the route param keys that contribute to the pathname.
    result.push({
      name: segment.name,
      paramName: segment.paramName,
      paramType: segment.paramType,
    })
  }

  return result
}

/**
 * Extracts pathname route param segments from a loader tree and resolves
 * parameter values from static segments in the route.
 *
 * @param loaderTree - The loader tree structure containing route hierarchy
 * @param route - The target route to match against
 * @returns Object containing pathname route param segments and resolved params
 */
export function extractPathnameRouteParamSegmentsFromLoaderTree(
  loaderTree: LoaderTree,
  route: NormalizedAppRoute
): {
  pathnameRouteParamSegments: Array<{
    readonly name: string
    readonly paramName: string
    readonly paramType: DynamicParamTypes
  }>
  params: Params
} {
  const pathnameRouteParamSegments: Array<{
    readonly name: string
    readonly paramName: string
    readonly paramType: DynamicParamTypes
  }> = []
  const params: Params = {}

  // BFS traversal with depth and path tracking
  const queue: Array<{
    tree: LoaderTree
    depth: number
    currentPath: NormalizedAppRouteSegment[]
  }> = [{ tree: loaderTree, depth: 0, currentPath: [] }]

  while (queue.length > 0) {
    const { tree, depth, currentPath } = queue.shift()!
    const { segment, parallelRoutes } = parseLoaderTree(tree)

    // Build the path for the current node
    let updatedPath = currentPath
    let nextDepth = depth

    const appSegment = parseAppRouteSegment(segment)

    // Only add to path if it's a real segment that appears in the URL
    // Route groups and parallel markers don't contribute to URL pathname
    if (
      appSegment &&
      appSegment.type !== 'route-group' &&
      appSegment.type !== 'parallel-route'
    ) {
      updatedPath = [...currentPath, appSegment]
      nextDepth = depth + 1
    }

    // Check if this segment has a param and matches the target pathname at this depth
    if (appSegment?.type === 'dynamic') {
      const { paramName, paramType } = appSegment.param

      // Check if this segment is at the correct depth in the target pathname
      // A segment matches if:
      // 1. There's a dynamic segment at this depth in the pathname
      // 2. The parameter names match (e.g., [id] matches [id], not [category])
      // 3. The static segments leading up to this point match (prefix check)
      if (depth < route.segments.length) {
        const targetSegment = route.segments[depth]

        // Match if the target pathname has a dynamic segment at this depth
        if (targetSegment.type === 'dynamic') {
          // Check that parameter names match exactly
          // This prevents [category] from matching against /[id]
          if (paramName !== targetSegment.param.paramName) {
            continue // Different param names, skip this segment
          }

          // Validate that the path leading up to this dynamic segment matches
          // the target pathname. This prevents false matches like extracting
          // [slug] from "/news/[slug]" when the tree has "/blog/[slug]"
          if (validatePrefixMatch(currentPath, route)) {
            pathnameRouteParamSegments.push({
              name: segment,
              paramName,
              paramType,
            })
          }
        }
      }

      // Resolve parameter value if it's not already known.
      if (!params.hasOwnProperty(paramName)) {
        const paramValue = resolveParamValue(
          paramName,
          paramType,
          depth,
          route,
          params
        )

        if (paramValue !== undefined) {
          params[paramName] = paramValue
        }
      }
    }

    // Continue traversing all parallel routes to find matching segments
    for (const parallelRoute of Object.values(parallelRoutes)) {
      queue.push({
        tree: parallelRoute,
        depth: nextDepth,
        currentPath: updatedPath,
      })
    }
  }

  return { pathnameRouteParamSegments, params }
}

/**
 * Resolves all route parameters from the loader tree. This function uses
 * tree-based traversal to correctly handle the hierarchical structure of routes
 * and accurately determine parameter values based on their depth in the tree.
 *
 * This processes both regular route parameters (from the main children route) and
 * parallel route parameters (from slots like @modal, @sidebar).
 *
 * Unlike interpolateParallelRouteParams (which has a complete URL at runtime),
 * this build-time function determines which route params are unknown.
 * The pathname may contain placeholders like [slug], making it incomplete.
 *
 * @param loaderTree - The loader tree structure containing route hierarchy
 * @param params - The current route parameters object (will be mutated)
 * @param route - The current route being processed
 * @param fallbackRouteParams - Array of fallback route parameters (will be mutated)
 */
export function resolveRouteParamsFromTree(
  loaderTree: LoaderTree,
  params: Params,
  route: NormalizedAppRoute,
  fallbackRouteParams: FallbackRouteParam[]
): void {
  // Stack-based traversal with depth tracking
  const stack: Array<{
    tree: LoaderTree
    depth: number
  }> = [{ tree: loaderTree, depth: 0 }]

  while (stack.length > 0) {
    const { tree, depth } = stack.pop()!
    const { segment, parallelRoutes } = parseLoaderTree(tree)

    const appSegment = parseAppRouteSegment(segment)

    // If this segment is a route parameter, then we should process it if it's
    // not already known and is not already marked as a fallback route param.
    if (
      appSegment?.type === 'dynamic' &&
      !params.hasOwnProperty(appSegment.param.paramName) &&
      !fallbackRouteParams.some(
        (param) => param.paramName === appSegment.param.paramName
      )
    ) {
      const { paramName, paramType } = appSegment.param

      const paramValue = resolveParamValue(
        paramName,
        paramType,
        depth,
        route,
        params
      )

      if (paramValue !== undefined) {
        params[paramName] = paramValue
      } else if (paramType !== 'optional-catchall') {
        // If we couldn't resolve the param, mark it as a fallback
        fallbackRouteParams.push({ paramName, paramType })
      }
    }

    // Calculate next depth - increment if this is not a route group and not empty
    let nextDepth = depth
    if (
      appSegment &&
      appSegment.type !== 'route-group' &&
      appSegment.type !== 'parallel-route'
    ) {
      nextDepth++
    }

    // Add all parallel routes to the stack for processing.
    for (const parallelRoute of Object.values(parallelRoutes)) {
      stack.push({ tree: parallelRoute, depth: nextDepth })
    }
  }
}
