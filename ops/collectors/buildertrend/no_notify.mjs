// no_notify.mjs — every schedule-item save made by PKB Ops goes out with ALL notifications off (Victor,
// 11/19/26: "você deve desmarcar a opção de notificar o Sub"). Rewrites the PUT/POST body the editor sends.
export async function noNotify(page, log = () => {}) {
  await page.route(/\/api\/calendar\/\d+(\?.*)?$/i, async (route) => {
    const req = route.request();
    if (!['PUT', 'POST'].includes(req.method())) return route.continue();
    let body; try { body = JSON.parse(req.postData() || '{}'); } catch { return route.continue(); }
    for (const k of ['notifyAffectedUsers', 'notifyAddedUsers', 'notifyRemovedUsers', 'notifyCurrentUsers']) if (k in body) body[k] = false;
    for (const k of ['addedUsersToNotify', 'removedUsersToNotify', 'currentUsersToNotify']) if (k in body) body[k] = [];
    if (body.notify && typeof body.notify === 'object') body.notify = { ...body.notify, notifyNewAssignees: [], notifyCurrentAssignees: [], notifyRemovedAssignees: [], notifyLinked: false };
    log(`notifications off: notifyAffectedUsers=${body.notifyAffectedUsers}`);
    return route.continue({ postData: JSON.stringify(body) });
  });
}
