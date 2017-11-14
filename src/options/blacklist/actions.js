import { createAction } from 'redux-act'

import { remoteFunction } from 'src/util/webextensionRPC'

const deleteDocs = remoteFunction('deleteDocsByUrl')

export const toggleModal = createAction('settings/toggleBlacklistModal')
export const setIsRemoving = createAction('settings/setIsRemoving')
export const setSiteInputValue = createAction('settings/setSiteInputValue')
export const resetSiteInputValue = createAction('settings/resetSiteInputValue')
export const setBlacklist = createAction('settings/setBlacklist')
export const addSiteToBlacklist = createAction('settings/addSiteToBlacklist')
export const removeSiteFromBlacklist = createAction(
    'settings/removeSiteFromBlacklist',
)

export const addToBlacklist = expression => dispatch => {
    dispatch(addSiteToBlacklist({ expression, dateAdded: Date.now() }))
    dispatch(resetSiteInputValue())
    dispatch(toggleModal())
}

export const removeMatchingDocs = expression => async dispatch => {
    dispatch(setIsRemoving(true))

    try {
        await deleteDocs(expression, 'regex')
        dispatch(toggleModal())
    } catch (error) {
        console.error(error)
    } finally {
        dispatch(setIsRemoving(false))
    }
}
