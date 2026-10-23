/**
 * Network Extraction Module
 * Contains pure functions to process social media posts and generate graph structures.
 */

// =========================
// Mention Network (User -> User)
// =========================
import { perfMonitor } from './performance-utils.js';

export async function extractMentionNetwork(posts, onProgress) {
    const nodeMap = new Map();
    const links = [];
    const chunkSize = 5000; // Reduced for massive datasets
    let debugCount = 0;

    for (let i = 0; i < posts.length; i += chunkSize) {
        const end = Math.min(i + chunkSize, posts.length);
        for (let j = i; j < end; j++) {
            const post = posts[j];
            const author = post.data?.author;
            if (!author) continue;

            const authorId = author.id;
            if (!authorId) continue;

            if (!nodeMap.has(authorId)) {
                nodeMap.set(authorId, {
                    id: authorId,
                    label: author.uniqueId || author.nickname,
                    verified: author.verified,
                    followers: post.data?.authorStats?.followerCount || 0,
                    type: 'user'
                });
            }
            const mentions = post.data?.textExtra?.filter(t => t.type === 0) || [];

            // Debug first few posts
            if (debugCount < 3 && mentions.length > 0) {
                console.log(`Post ${post.item_id}: authorId=${authorId}, ${mentions.length} mentions`, mentions.map(m => `${m.userUniqueId}(${m.userId})`));
                debugCount++;
            }

            mentions.forEach(mention => {
                // Use userId if available, otherwise create ID from username
                const mentionId = mention.userId || `user_${mention.userUniqueId}`;
                if (!mentionId || mentionId === 'user_undefined') return; // Skip invalid mentions

                if (!nodeMap.has(mentionId)) {
                    nodeMap.set(mentionId, {
                        id: mentionId,
                        label: mention.userUniqueId || String(mentionId),
                        type: 'user',
                        followers: 0
                    });
                }
                links.push({ source: authorId, target: mentionId, postId: post.item_id });
            });
        }

        // Report progress and yield
        if (onProgress) {
            const progress = Math.floor((end / posts.length) * 100);
            onProgress(`Building mention network... ${progress}% (${end}/${posts.length} posts)`);
        }

        if (i + chunkSize < posts.length) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    console.log(`Mention network: ${nodeMap.size} nodes, ${links.length} links`);
    return { nodes: Array.from(nodeMap.values()), links };
}

// =========================
// Co-Hashtag Network (Hashtag <-> Hashtag)
// =========================
export async function extractCoHashtagNetwork(posts, onProgress) {
    const nodeMap = new Map();
    const linkMap = new Map();
    const chunkSize = 5000; // Reduced for massive datasets

    for (let i = 0; i < posts.length; i += chunkSize) {
        const end = Math.min(i + chunkSize, posts.length);
        for (let j = i; j < end; j++) {
            const post = posts[j];
            const hashtags = post.data?.challenges || [];
            hashtags.forEach(tag => {
                const tagId = tag.id;
                if (!nodeMap.has(tagId)) nodeMap.set(tagId, { id: tagId, label: tag.title, count: 0, type: 'hashtag' });
                nodeMap.get(tagId).count++;
            });
            for (let m = 0; m < hashtags.length; m++) {
                for (let n = m + 1; n < hashtags.length; n++) {
                    const source = hashtags[m].id, target = hashtags[n].id;
                    const key = [source, target].sort().join('-');
                    if (!linkMap.has(key)) linkMap.set(key, { source, target, weight: 0 });
                    linkMap.get(key).weight++;
                }
            }
        }

        if (onProgress) {
            const progress = Math.floor((end / posts.length) * 100);
            onProgress(`Building co-hashtag network... ${progress}%`);
        }
        if (i + chunkSize < posts.length) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    console.log(`Co-hashtag network: ${nodeMap.size} nodes, ${linkMap.size} links`);
    return { nodes: Array.from(nodeMap.values()), links: Array.from(linkMap.values()) };
}

// =========================
// User-Hashtag Network (User -> Hashtag)
// =========================
export async function extractUserHashtagNetwork(posts, onProgress) {
    const nodeMap = new Map();
    const links = [];
    const chunkSize = 5000; // Reduced for massive datasets

    for (let i = 0; i < posts.length; i += chunkSize) {
        const end = Math.min(i + chunkSize, posts.length);
        for (let j = i; j < end; j++) {
            const post = posts[j];
            const author = post.data?.author;
            if (!author) continue;

            const authorId = `u_${author.id}`;
            if (!nodeMap.has(authorId)) {
                nodeMap.set(authorId, {
                    id: authorId, label: author.uniqueId || author.nickname, type: 'user',
                    verified: author.verified, followers: post.data?.authorStats?.followerCount || 0
                });
            }
            const hashtags = post.data?.challenges || [];
            hashtags.forEach(tag => {
                const tagId = `h_${tag.id}`;
                if (!nodeMap.has(tagId)) nodeMap.set(tagId, { id: tagId, label: tag.title, type: 'hashtag', count: 0 });
                nodeMap.get(tagId).count++;
                links.push({ source: authorId, target: tagId, postId: post.item_id });
            });
        }

        if (onProgress) {
            const progress = Math.floor((end / posts.length) * 100);
            onProgress(`Building user-hashtag network... ${progress}%`);
        }
        if (i + chunkSize < posts.length) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    return { nodes: Array.from(nodeMap.values()), links };
}

// =========================
// Hashtag Network (Hashtag-only simple list extraction)
// =========================
export async function extractHashtagNetwork(posts, onProgress) {
    const nodeMap = new Map();
    const chunkSize = 5000; // Reduced for massive datasets

    for (let i = 0; i < posts.length; i += chunkSize) {
        const end = Math.min(i + chunkSize, posts.length);
        for (let j = i; j < end; j++) {
            const post = posts[j];
            const hashtags = post.data?.challenges || [];
            hashtags.forEach(tag => {
                if (!nodeMap.has(tag.id)) nodeMap.set(tag.id, { id: tag.id, label: tag.title, count: 0, totalEngagement: 0, type: 'hashtag' });
                const node = nodeMap.get(tag.id);
                node.count++;
                node.totalEngagement += (post.data?.stats?.diggCount || 0);
            });
        }

        if (onProgress) {
            const progress = Math.floor((end / posts.length) * 100);
            onProgress(`Building hashtag network... ${progress}%`);
        }
        if (i + chunkSize < posts.length) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    return { nodes: Array.from(nodeMap.values()), links: [] };
}

// =========================
// Photo Tag Network (Instagram)
// =========================
export async function extractPhotoTagNetwork(posts, onProgress) {
    const nodeMap = new Map();
    const links = [];
    const chunkSize = 5000; // Reduced for massive datasets

    for (let i = 0; i < posts.length; i += chunkSize) {
        const end = Math.min(i + chunkSize, posts.length);
        for (let j = i; j < end; j++) {
            const post = posts[j];
            if (post.platform !== 'instagram') continue; // Only Instagram has photo tags

            const author = post.data?.author;
            const usertags = post.data?._instagram?.usertags?.in || [];

            if (!author || usertags.length === 0) continue;

            const authorId = `u_${author.id}`;
            if (!nodeMap.has(authorId)) {
                nodeMap.set(authorId, {
                    id: authorId,
                    label: author.uniqueId || author.nickname,
                    type: 'user',
                    verified: author.verified,
                    followers: post.data?.authorStats?.followerCount || 0
                });
            }

            // Create connections to tagged users
            usertags.forEach(tag => {
                const taggedUser = tag.user;
                if (!taggedUser) return;

                const taggedId = `u_${taggedUser.id}`;
                if (!nodeMap.has(taggedId)) {
                    nodeMap.set(taggedId, {
                        id: taggedId,
                        label: taggedUser.username,
                        type: 'user',
                        verified: taggedUser.is_verified || false,
                        followers: taggedUser.follower_count || 0
                    });
                }

                links.push({ source: authorId, target: taggedId, postId: post.item_id });
            });
        }

        if (onProgress) {
            const progress = Math.floor((end / posts.length) * 100);
            onProgress(`Building photo tag network... ${progress}%`);
        }
        if (i + chunkSize < posts.length) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    return { nodes: Array.from(nodeMap.values()), links };
}

// =========================
// Location Network (Instagram)
// =========================
export async function extractLocationNetwork(posts, onProgress) {
    const nodeMap = new Map();
    const links = [];
    const chunkSize = 5000; // Reduced for massive datasets

    for (let i = 0; i < posts.length; i += chunkSize) {
        const end = Math.min(i + chunkSize, posts.length);
        for (let j = i; j < end; j++) {
            const post = posts[j];
            if (post.platform !== 'instagram') continue; // Only Instagram has location data

            const author = post.data?.author;
            const location = post.data?._instagram?.location;

            if (!author || !location) continue;

            const authorId = `u_${author.id}`;
            if (!nodeMap.has(authorId)) {
                nodeMap.set(authorId, {
                    id: authorId,
                    label: author.uniqueId || author.nickname,
                    type: 'user',
                    verified: author.verified,
                    followers: post.data?.authorStats?.followerCount || 0
                });
            }

            const locationId = `loc_${location.pk}`;
            if (!nodeMap.has(locationId)) {
                nodeMap.set(locationId, {
                    id: locationId,
                    label: location.name,
                    type: 'location',
                    count: 0,
                    lat: location.lat,
                    lng: location.lng
                });
            }

            nodeMap.get(locationId).count++;
            links.push({ source: authorId, target: locationId, postId: post.item_id });
        }

        if (onProgress) {
            const progress = Math.floor((end / posts.length) * 100);
            onProgress(`Building location network... ${progress}%`);
        }
        if (i + chunkSize < posts.length) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    return { nodes: Array.from(nodeMap.values()), links };
}

// =========================
// URL Co-share Network (User <-> URL) — Session 5
// Bipartite: users linked to the normalized URLs they shared. Hub URLs reveal
// link-spam campaigns; users sharing the same rare URL cluster together.
// =========================
export async function extractUrlCoshareNetwork(posts, onProgress) {
    const nodeMap = new Map();
    const links = [];
    const chunkSize = 5000;

    for (let i = 0; i < posts.length; i += chunkSize) {
        const end = Math.min(i + chunkSize, posts.length);
        for (let j = i; j < end; j++) {
            const post = posts[j];
            const author = post.data?.author;
            const urls = post.data?.urls;
            if (!author?.id || !urls || urls.length === 0) continue;

            const authorId = author.id;
            if (!nodeMap.has(authorId)) {
                nodeMap.set(authorId, {
                    id: authorId,
                    label: author.uniqueId || author.nickname || String(authorId),
                    type: 'user',
                    verified: author.verified,
                    followers: post.data?.authorStats?.followerCount || 0
                });
            }

            const seen = new Set();
            for (const u of urls) {
                if (!u?.url || seen.has(u.url)) continue;
                seen.add(u.url);
                const urlId = `url_${u.url}`;
                if (!nodeMap.has(urlId)) {
                    nodeMap.set(urlId, { id: urlId, label: u.domain || u.url, type: 'hashtag', count: 0 });
                }
                nodeMap.get(urlId).count++;
                links.push({ source: authorId, target: urlId, postId: post.item_id });
            }
        }
        if (onProgress) onProgress(`Building URL co-share network... ${Math.floor((end / posts.length) * 100)}%`);
        if (i + chunkSize < posts.length) await new Promise(resolve => setTimeout(resolve, 0));
    }

    return { nodes: Array.from(nodeMap.values()), links };
}

// =========================
// Repost / Amplification Network (User -> amplified account) — Session 5
// Directed: who amplifies whom. Usually the most informative structure in
// Twitter/X datasets. Other platforms have no repost data (guarded).
// =========================
export async function extractRepostNetwork(posts, onProgress) {
    const nodeMap = new Map();
    const links = [];
    const chunkSize = 5000;

    for (let i = 0; i < posts.length; i += chunkSize) {
        const end = Math.min(i + chunkSize, posts.length);
        for (let j = i; j < end; j++) {
            const post = posts[j];
            const author = post.data?.author;
            const repost = post.data?.repost;
            if (!author?.id || !repost?.targetId) continue;

            const authorId = author.id;
            if (!nodeMap.has(authorId)) {
                nodeMap.set(authorId, {
                    id: authorId,
                    label: author.uniqueId || author.nickname || String(authorId),
                    type: 'user',
                    verified: author.verified,
                    followers: post.data?.authorStats?.followerCount || 0
                });
            }

            const targetId = `amp_${repost.targetId}`;
            if (!nodeMap.has(targetId)) {
                nodeMap.set(targetId, { id: targetId, label: repost.targetName || String(repost.targetId), type: 'user', count: 0 });
            }
            nodeMap.get(targetId).count++;
            links.push({ source: authorId, target: targetId, postId: post.item_id, kind: repost.kind });
        }
        if (onProgress) onProgress(`Building repost network... ${Math.floor((end / posts.length) * 100)}%`);
        if (i + chunkSize < posts.length) await new Promise(resolve => setTimeout(resolve, 0));
    }

    return { nodes: Array.from(nodeMap.values()), links };
}
