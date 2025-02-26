import { Between } from 'typeorm'
import { isLabelSource, LabelSource } from '../../entity/entity_label'
import { Label } from '../../entity/label'
import { env } from '../../env'
import {
  CreateLabelError,
  CreateLabelErrorCode,
  CreateLabelSuccess,
  DeleteLabelError,
  DeleteLabelErrorCode,
  DeleteLabelSuccess,
  LabelsError,
  LabelsErrorCode,
  LabelsSuccess,
  MoveLabelError,
  MoveLabelErrorCode,
  MoveLabelSuccess,
  MutationCreateLabelArgs,
  MutationDeleteLabelArgs,
  MutationMoveLabelArgs,
  MutationSetLabelsArgs,
  MutationSetLabelsForHighlightArgs,
  MutationUpdateLabelArgs,
  SetLabelsError,
  SetLabelsErrorCode,
  SetLabelsSuccess,
  UpdateLabelError,
  UpdateLabelErrorCode,
  UpdateLabelSuccess,
} from '../../generated/graphql'
import { labelRepository } from '../../repository/label'
import { userRepository } from '../../repository/user'
import {
  deleteLabelById,
  findOrCreateLabels,
  saveLabelsInHighlight,
  saveLabelsInLibraryItem,
  updateLabel,
} from '../../services/labels'
import { analytics } from '../../utils/analytics'
import { authorized } from '../../utils/gql-utils'

export const labelsResolver = authorized<LabelsSuccess, LabelsError>(
  async (_obj, _params, { authTrx, log, uid }) => {
    try {
      const user = await userRepository.findById(uid)
      if (!user) {
        return {
          errorCodes: [LabelsErrorCode.Unauthorized],
        }
      }

      const labels = await authTrx(async (tx) => {
        return tx.withRepository(labelRepository).find({
          where: {
            user: { id: uid },
          },
          order: {
            name: 'ASC',
          },
        })
      })

      analytics.track({
        userId: uid,
        event: 'labels',
        properties: {
          env: env.server.apiEnv,
          $set: {
            email: user.email,
            username: user.profile.username,
          },
        },
      })

      return {
        labels,
      }
    } catch (error) {
      log.error('labelsResolver', error)
      return {
        errorCodes: [LabelsErrorCode.BadRequest],
      }
    }
  }
)

export const createLabelResolver = authorized<
  CreateLabelSuccess,
  CreateLabelError,
  MutationCreateLabelArgs
>(async (_, { input }, { authTrx, log, uid }) => {
  try {
    const label = await authTrx(async (tx) => {
      return tx.withRepository(labelRepository).createLabel(input, uid)
    })

    analytics.track({
      userId: uid,
      event: 'label_created',
      properties: {
        ...input,
        env: env.server.apiEnv,
      },
    })

    return {
      label,
    }
  } catch (error) {
    log.error('createLabelResolver', error)
    return {
      errorCodes: [CreateLabelErrorCode.BadRequest],
    }
  }
})

export const deleteLabelResolver = authorized<
  DeleteLabelSuccess,
  DeleteLabelError,
  MutationDeleteLabelArgs
>(async (_, { id: labelId }, { log, uid }) => {
  try {
    const deleted = await deleteLabelById(labelId, uid)
    if (!deleted) {
      return {
        errorCodes: [DeleteLabelErrorCode.NotFound],
      }
    }

    analytics.track({
      userId: uid,
      event: 'label_deleted',
      properties: {
        labelId,
        env: env.server.apiEnv,
      },
    })

    return {
      label: {
        id: labelId,
        name: '',
        color: '',
      },
    }
  } catch (error) {
    log.error('error deleting label', error)
    return {
      errorCodes: [DeleteLabelErrorCode.BadRequest],
    }
  }
})

export const setLabelsResolver = authorized<
  SetLabelsSuccess,
  SetLabelsError,
  MutationSetLabelsArgs
>(
  async (
    _,
    { input: { pageId, labelIds, labels, source } },
    { uid, log, authTrx, pubsub }
  ) => {
    if (!labelIds && !labels) {
      log.error('labelIds or labels must be provided')
      return {
        errorCodes: [SetLabelsErrorCode.BadRequest],
      }
    }

    let labelSource: LabelSource | undefined

    // check if source is valid
    if (source) {
      if (!isLabelSource(source)) {
        log.error('invalid source', source)

        return {
          errorCodes: [SetLabelsErrorCode.BadRequest],
        }
      }

      labelSource = source
    }

    try {
      let labelsSet: Label[] = []

      if (labels && labels.length > 0) {
        // for new clients that send label names
        // create labels if they don't exist
        labelsSet = await findOrCreateLabels(labels, uid)
      } else if (labelIds && labelIds.length > 0) {
        // for old clients that send labelIds
        labelsSet = await authTrx(async (tx) => {
          return tx.withRepository(labelRepository).findLabelsById(labelIds)
        })

        if (labelsSet.length !== labelIds.length) {
          return {
            errorCodes: [SetLabelsErrorCode.NotFound],
          }
        }
      }

      // save labels in the library item
      await saveLabelsInLibraryItem(labelsSet, pageId, uid, labelSource, pubsub)

      analytics.track({
        userId: uid,
        event: 'labels_set',
        properties: {
          pageId,
          labelIds,
          env: env.server.apiEnv,
        },
      })

      return {
        labels: labelsSet,
      }
    } catch (error) {
      log.error('setLabelsResolver error', error)
      return {
        errorCodes: [SetLabelsErrorCode.BadRequest],
      }
    }
  }
)

export const updateLabelResolver = authorized<
  UpdateLabelSuccess,
  UpdateLabelError,
  MutationUpdateLabelArgs
>(async (_, { input: { name, color, description, labelId } }, { uid, log }) => {
  try {
    const label = await updateLabel(labelId, { name, color, description }, uid)

    return { label }
  } catch (error) {
    log.error('error updating label', error)
    return {
      errorCodes: [UpdateLabelErrorCode.BadRequest],
    }
  }
})

export const setLabelsForHighlightResolver = authorized<
  SetLabelsSuccess,
  SetLabelsError,
  MutationSetLabelsForHighlightArgs
>(async (_, { input }, { uid, log, pubsub, authTrx }) => {
  const { highlightId, labelIds, labels } = input

  if (!labelIds && !labels) {
    log.info('labelIds or labels must be provided')
    return {
      errorCodes: [SetLabelsErrorCode.BadRequest],
    }
  }

  try {
    let labelsSet: Label[] = []

    if (labels && labels.length > 0) {
      // for new clients that send label names
      // create labels if they don't exist
      labelsSet = await findOrCreateLabels(labels, uid)
    } else if (labelIds && labelIds.length > 0) {
      // for old clients that send labelIds
      labelsSet = await authTrx(async (tx) => {
        return tx.withRepository(labelRepository).findLabelsById(labelIds)
      })
      if (labelsSet.length !== labelIds.length) {
        return {
          errorCodes: [SetLabelsErrorCode.NotFound],
        }
      }
    }

    // save labels in the highlight
    await saveLabelsInHighlight(labelsSet, input.highlightId, uid, pubsub)

    analytics.track({
      userId: uid,
      event: 'labels_set_for_highlight',
      properties: {
        highlightId,
        labelIds,
        env: env.server.apiEnv,
      },
    })

    return {
      labels: labelsSet,
    }
  } catch (error) {
    log.error('setLabelsForHighlightResolver error', error)
    return {
      errorCodes: [SetLabelsErrorCode.BadRequest],
    }
  }
})

export const moveLabelResolver = authorized<
  MoveLabelSuccess,
  MoveLabelError,
  MutationMoveLabelArgs
>(async (_, { input }, { authTrx, log, uid }) => {
  const { labelId, afterLabelId } = input

  try {
    const label = await authTrx(async (tx) => {
      return tx.withRepository(labelRepository).findById(labelId)
    })
    if (!label) {
      return {
        errorCodes: [MoveLabelErrorCode.NotFound],
      }
    }

    if (label.id === afterLabelId) {
      // nothing to do
      return { label }
    }

    const oldPosition = label.position
    // if afterLabelId is not provided, move to the top
    let newPosition = 1
    if (afterLabelId) {
      const afterLabel = await authTrx(async (tx) => {
        return tx.withRepository(labelRepository).findById(afterLabelId)
      })
      if (!afterLabel) {
        return {
          errorCodes: [MoveLabelErrorCode.NotFound],
        }
      }

      newPosition = afterLabel.position
    }
    const moveUp = newPosition < oldPosition

    // move label to the new position
    const updated = await authTrx(async (tx) => {
      const labelRepo = tx.withRepository(labelRepository)
      // update the position of the other labels
      const updated = await labelRepo.update(
        {
          position: Between(
            Math.min(newPosition, oldPosition),
            Math.max(newPosition, oldPosition)
          ),
        },
        {
          position: () => `position + ${moveUp ? 1 : -1}`,
        }
      )
      if (!updated.affected) {
        return null
      }

      // update the position of the label
      return labelRepo.save({
        id: labelId,
        position: newPosition,
      })
    })

    if (!updated) {
      return {
        errorCodes: [MoveLabelErrorCode.BadRequest],
      }
    }

    analytics.track({
      userId: uid,
      event: 'label_moved',
      properties: {
        labelId,
        afterLabelId,
        env: env.server.apiEnv,
      },
    })

    return {
      label: updated,
    }
  } catch (error) {
    log.error('error moving label', error)
    return {
      errorCodes: [MoveLabelErrorCode.BadRequest],
    }
  }
})
