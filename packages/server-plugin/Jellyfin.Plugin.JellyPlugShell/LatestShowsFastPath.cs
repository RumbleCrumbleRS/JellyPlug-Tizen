using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;

namespace Jellyfin.Plugin.JellyPlugShell;

/// <summary>
/// JELA-731. Builds the Home Screen Sections "Latest Shows" row with one query per
/// TV library instead of the plugin's 30-day sliding-window scan.
///
/// <para>The upstream section (<c>LatestShowsSection.GetResults</c>) walks backwards
/// through time in 30-day windows, running one episode query per TV library per window
/// with <c>EnableTotalRecordCount = true</c>, and stops only once 16 distinct series
/// have accumulated (escape hatch: the year 1925). How far it has to walk is a property
/// of the library's episode <em>premiere dates</em>, not of its size — a library whose
/// recent months are thin pays a window per 30 days of quiet. Measured against
/// production 2026-08-25: <b>27 windows x 2 TV libraries = 54 queries, 1,166 ms of
/// cumulative server time</b> for a row of 16 titles. The equivalent Movies row stops
/// in a handful of windows, which is the whole of the ~21x gap in JELA-731's title.</para>
///
/// <para>The row it produces is defined purely by the top-N episodes by premiere date,
/// so the windows are wasted work: take the most recent episodes across the TV
/// libraries in a single ordered query, group them by series, keep the 16 series with
/// the newest episode. Verified byte-for-byte against the live section on production:
/// the same 16 titles in the same order (JELA-731 AC3).</para>
///
/// <para>Deliberately conservative — every path that cannot be shown to reproduce
/// upstream's answer returns <c>null</c> and lets the real section serve the request:
/// Home Screen Sections not loaded, its configuration unreadable, the section's
/// <c>HideWatchedItems</c> setting on (a filter this fast path does not model), a user
/// we cannot resolve, or any exception at all. The failure mode is today's latency,
/// never a wrong row.</para>
/// </summary>
public static class LatestShowsFastPath
{
    /// <summary>The section id this fast path stands in for.</summary>
    public const string SectionId = "LatestShows";

    /// <summary>
    /// Rows returned. Fixed at 16 by <c>LatestShowsSection</c>: it takes 16 per window
    /// and stops accumulating at 16.
    /// </summary>
    private const int SeriesLimit = 16;

    /// <summary>
    /// Episodes pulled per TV library on the first pass. 200 is upstream's own per-window
    /// limit and covers 27 windows' worth of production history in one query; the
    /// doubling below covers libraries where a few very long-running series crowd out the
    /// first page.
    /// </summary>
    private const int InitialEpisodeProbe = 200;

    /// <summary>
    /// Ceiling for the doubling. A library that cannot yield 16 distinct series inside its
    /// 3,200 most recent episodes has fewer than 16 series with dated episodes, and
    /// upstream would return a short row too.
    /// </summary>
    private const int MaxEpisodeProbe = 3200;

    /// <summary>
    /// Builds the row, or returns <c>null</c> to defer to Home Screen Sections.
    /// </summary>
    public static QueryResult<BaseItemDto>? TryBuild(
        Guid userId,
        IUserManager userManager,
        ILibraryManager libraryManager,
        IDtoService dtoService)
    {
        // Upstream applies IsPlayed=false when the section's HideWatchedItems is on.
        // Modelling that here would change which episodes are visible per user, so the
        // fast path simply steps aside instead — including when the setting cannot be
        // read at all (Home Screen Sections absent, or its shape changed under us).
        if (HideWatchedItems() != false)
        {
            return null;
        }

        var user = userManager.GetUserById(userId);
        if (user is null)
        {
            return null;
        }

        // GetChildren(user, ...) is already permission-filtered, and is how upstream
        // enumerates the very same libraries in CreateInstances.
        var tvFolders = libraryManager.GetUserRootFolder()
            .GetChildren(user, true)
            .OfType<Folder>()
            .Where(x => (x as ICollectionFolder)?.CollectionType == CollectionType.tvshows)
            .ToArray();

        if (tvFolders.Length == 0)
        {
            return null;
        }

        var dtoOptions = SectionDtoOptions();

        // DateTime.Now, not UtcNow: upstream's window walk starts at DateTime.Now and
        // PremiereDate comparisons in the item query are made against local time.
        var now = DateTime.Now;

        var latestPerSeries = new Dictionary<Guid, DateTime?>();
        var order = new List<Guid>();

        for (var probe = InitialEpisodeProbe; ; probe *= 2)
        {
            latestPerSeries.Clear();
            order.Clear();

            var exhausted = true;

            foreach (var folder in tvFolders)
            {
                var page = folder.GetItems(new InternalItemsQuery(user)
                {
                    IncludeItemTypes = new[] { BaseItemKind.Episode },
                    OrderBy = new[] { (ItemSortBy.PremiereDate, SortOrder.Descending) },
                    Limit = probe,
                    IsVirtualItem = false,
                    Recursive = true,
                    ParentId = folder.Id,

                    // Upstream's window walk starts at "now" and so never reaches
                    // unaired episodes; without a window we have to say so.
                    MaxPremiereDate = now,

                    // Upstream asks for it and throws it away. It costs a second pass
                    // over the same filtered set, per query, per window.
                    EnableTotalRecordCount = false,

                    // Nothing below needs an image, a user-data row or a DTO: the
                    // episodes are read for SeriesId and PremiereDate only.
                    DtoOptions = new DtoOptions(false) { EnableImages = false }
                });

                if (page.Items.Count >= probe)
                {
                    exhausted = false;
                }

                foreach (var item in page.Items)
                {
                    if (item is not Episode episode || episode.IsUnaired)
                    {
                        continue;
                    }

                    var seriesId = episode.SeriesId;
                    if (seriesId.Equals(default))
                    {
                        continue;
                    }

                    if (latestPerSeries.TryGetValue(seriesId, out var known))
                    {
                        if (episode.PremiereDate > known)
                        {
                            latestPerSeries[seriesId] = episode.PremiereDate;
                        }
                    }
                    else
                    {
                        latestPerSeries[seriesId] = episode.PremiereDate;
                        order.Add(seriesId);
                    }
                }
            }

            // Enough distinct series, or the libraries have no more episodes to give,
            // or we have read as deep as we are willing to.
            if (latestPerSeries.Count >= SeriesLimit || exhausted || probe * 2 > MaxEpisodeProbe)
            {
                break;
            }
        }

        var seriesIds = order
            .OrderByDescending(id => latestPerSeries[id])
            .Take(SeriesLimit)
            .ToArray();

        if (seriesIds.Length == 0)
        {
            return new QueryResult<BaseItemDto>(Array.Empty<BaseItemDto>());
        }

        var seriesItems = libraryManager.GetItemList(new InternalItemsQuery(user)
        {
            ItemIds = seriesIds,
            DtoOptions = dtoOptions
        });

        // ItemIds does not preserve the order it was given, and the row's order is the
        // whole point of the section.
        var byId = seriesItems.ToDictionary(x => x.Id);

        var dtos = seriesIds
            .Where(byId.ContainsKey)
            .Select(id => dtoService.GetBaseItemDto(byId[id], dtoOptions, user))
            .ToArray();

        return new QueryResult<BaseItemDto>(dtos);
    }

    /// <summary>
    /// The DTO shape <c>LatestShowsSection.GetResults</c> hands to <c>GetBaseItemDto</c>.
    /// Kept identical so the row's cards render from the same fields they do today.
    /// </summary>
    /// <remarks>
    /// Internal rather than private since JELA-798, where <see cref="SectionWarmService"/>
    /// grew a movies half that warms with the same shape. The DTO shape is load-bearing
    /// to a warmer specifically because it decides how much image work the pass does, and
    /// JELA-793 measured that a pass which asks for a cheaper shape than the request it is
    /// warming for is a null.
    /// </remarks>
    internal static DtoOptions SectionDtoOptions()
    {
        var dtoOptions = new DtoOptions
        {
            Fields = new List<ItemFields>
            {
                ItemFields.PrimaryImageAspectRatio,
                ItemFields.Path
            }
        };

        dtoOptions.ImageTypeLimit = 1;
        dtoOptions.ImageTypes = new List<ImageType>
        {
            ImageType.Thumb,
            ImageType.Backdrop,
            ImageType.Primary
        };

        return dtoOptions;
    }

    /// <summary>
    /// Reads <c>HideWatchedItems</c> for the LatestShows section out of the live Home
    /// Screen Sections configuration.
    /// </summary>
    /// <returns>
    /// The setting, or <c>null</c> when it cannot be established — which callers must
    /// treat exactly like <c>true</c> and step aside for.
    /// </returns>
    /// <remarks>
    /// Read reflectively and re-read per request rather than referenced or cached: Home
    /// Screen Sections is a third-party plugin on its own release train, its
    /// configuration is edited live from the dashboard, and a compile-time reference
    /// would make this plugin fail to load without it. Everything here is a lookup by
    /// name with a null guard, so an upstream rename degrades to "no fast path".
    /// </remarks>
    internal static bool? HideWatchedItems()
    {
        try
        {
            var assembly = AppDomain.CurrentDomain.GetAssemblies()
                .FirstOrDefault(x => string.Equals(
                    x.GetName().Name,
                    "Jellyfin.Plugin.HomeScreenSections",
                    StringComparison.Ordinal));

            var pluginType = assembly?.GetType("Jellyfin.Plugin.HomeScreenSections.HomeScreenSectionsPlugin");
            var instance = pluginType?
                .GetProperty("Instance", BindingFlags.Public | BindingFlags.Static)?
                .GetValue(null);

            var configuration = instance?.GetType()
                .GetProperty("Configuration", BindingFlags.Public | BindingFlags.Instance)?
                .GetValue(instance);

            if (configuration?.GetType()
                    .GetProperty("SectionSettings", BindingFlags.Public | BindingFlags.Instance)?
                    .GetValue(configuration) is not IEnumerable sectionSettings)
            {
                return null;
            }

            foreach (var setting in sectionSettings)
            {
                if (setting is null)
                {
                    continue;
                }

                var type = setting.GetType();
                var id = type.GetProperty("SectionId")?.GetValue(setting) as string;
                if (!string.Equals(id, SectionId, StringComparison.Ordinal))
                {
                    continue;
                }

                return type.GetProperty("HideWatchedItems")?.GetValue(setting) as bool?;
            }

            // The section exists upstream but has no stored settings row yet, which is
            // upstream's own "HideWatchedItems is off" default.
            return false;
        }
        catch (Exception)
        {
            return null;
        }
    }
}
