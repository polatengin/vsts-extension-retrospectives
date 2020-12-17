import * as ExtensionDataService from './dataService';
import { IFeedbackItemDocument } from '../interfaces/feedback';
import { WorkItem } from 'TFS/WorkItemTracking/Contracts';
import { workItemService } from './azureDevOpsWorkItemService';
import { appInsightsClient, TelemetryExceptions } from '../utilities/appInsightsClient';
import { v4 as uuid } from 'uuid';
import { getUserIdentity } from '../utilities/userIdentityHelper';

class ItemDataService {
  /**
   * Create an item with given title and column id in the board.
   */
  public createItemForBoard = async (
    boardId: string, title: string, columnId: string, isAnonymous: boolean = true): Promise<IFeedbackItemDocument> => {
    const itemId: string = uuid();
    const userIdentity = getUserIdentity();

    const feedbackItem: IFeedbackItemDocument = {
      boardId,
      columnId,
      createdBy: isAnonymous ? null : userIdentity,
      createdDate: new Date(Date.now()),
      id: itemId,
      title,
      upvotes: 0,
      userIdRef: userIdentity.id,
    };

    const createdItem: IFeedbackItemDocument =
      await ExtensionDataService.createDocument<IFeedbackItemDocument>(boardId, feedbackItem);

    return createdItem;
  }

  /**
   * Get the feedback item.
   */
  public getFeedbackItem = async (boardId: string, feedbackItemId: string): Promise<IFeedbackItemDocument> => {
    const feedbackItem: IFeedbackItemDocument =
      await ExtensionDataService.readDocument<IFeedbackItemDocument>(boardId, feedbackItemId);
    return feedbackItem;
  }

  /**
   * Get all feedback items in the board.
   */
  public getFeedbackItemsForBoard = async (boardId: string): Promise<IFeedbackItemDocument[]> => {
    let feedbackItems: IFeedbackItemDocument[] = [];

    try {
      feedbackItems = await ExtensionDataService.readDocuments<IFeedbackItemDocument>(boardId, false, true);
    } catch (e) {
      if (e.serverError.typeKey === 'DocumentCollectionDoesNotExistException') {
        appInsightsClient.trackTrace(TelemetryExceptions.ItemsNotFoundForBoard, e, AI.SeverityLevel.Warning);
      }
    }

    return feedbackItems;
  }

  /**
   * Get feedback items in the board matching the specified item ids.
   */
  public getFeedbackItemsByIds = async (boardId: string, feedbackItemIds: string[]): Promise<IFeedbackItemDocument[]> => {
    const feedbackitemsForBoard: IFeedbackItemDocument[] = await this.getFeedbackItemsForBoard(boardId);
    const feedbackItems: IFeedbackItemDocument[] = feedbackitemsForBoard.filter(item => feedbackItemIds.find(id => id === item.id));
    return feedbackItems;
  }

  /**
   * Delete the feedback item and propagate the changes to the parent and children feedback items (if any).
   */
  public deleteFeedbackItem = async (boardId: string, feedbackItemId: string): Promise<{
    updatedParentFeedbackItem: IFeedbackItemDocument
    updatedChildFeedbackItems: IFeedbackItemDocument[]
  }> => {

    let updatedParentFeedbackItem: IFeedbackItemDocument = null;
    let updatedChildFeedbackItems: IFeedbackItemDocument[] = [];

    const feedbackItem: IFeedbackItemDocument = await ExtensionDataService.readDocument<IFeedbackItemDocument>(boardId, feedbackItemId);

    if (feedbackItem.parentFeedbackItemId) {
      const parentFeedbackItem: IFeedbackItemDocument =
        await ExtensionDataService.readDocument<IFeedbackItemDocument>(boardId, feedbackItem.parentFeedbackItemId);

      parentFeedbackItem.childFeedbackItemIds = parentFeedbackItem.childFeedbackItemIds.filter(id => id !== feedbackItemId);
      updatedParentFeedbackItem = await this.updateFeedbackItem(boardId, parentFeedbackItem);

    }
    else if (feedbackItem.childFeedbackItemIds) {
      const childFeedbackItemPromises = feedbackItem.childFeedbackItemIds.map((childFeedbackItemId) => {
        return ExtensionDataService.readDocument<IFeedbackItemDocument>(boardId, childFeedbackItemId);
      });

      const updatedChildFeedbackItemPromises = await Promise.all(childFeedbackItemPromises).then((childFeedbackItems) => {
        return childFeedbackItems.map((childFeedbackItem) => {
          childFeedbackItem.parentFeedbackItemId = null;
          return this.updateFeedbackItem(boardId, childFeedbackItem);
        })
      });

      updatedChildFeedbackItems = await Promise.all(updatedChildFeedbackItemPromises).then((updatedChildFeedbackItems) => {
        return updatedChildFeedbackItems.map((updatedChildFeedbackItem) => updatedChildFeedbackItem);
      });
    }

    await ExtensionDataService.deleteDocument(boardId, feedbackItemId);

    return {
      updatedParentFeedbackItem,
      updatedChildFeedbackItems
    };
  }

  /**
   * Update the feedback item.
   */
  private updateFeedbackItem = async (boardId: string, feedbackItem: IFeedbackItemDocument): Promise<IFeedbackItemDocument> => {
    const updatedFeedbackItem: IFeedbackItemDocument = await ExtensionDataService.updateDocument<IFeedbackItemDocument>(boardId, feedbackItem);
    return updatedFeedbackItem;
  }

  /**
   * Increment the upvote of the feedback item.
   */
  public incrementUpvote = async (boardId: string, feedbackItemId: string): Promise<IFeedbackItemDocument> => {
    const feedbackItem: IFeedbackItemDocument = await this.getFeedbackItem(boardId, feedbackItemId);

    if (!feedbackItem) {
      //`Cannot increment upvote for a non-existent feedback item. Board: ${boardId}, Item: ${feedbackItemId}`
      return undefined;
    }

    feedbackItem.upvotes++;

    const updatedFeedbackItem = await this.updateFeedbackItem(boardId, feedbackItem);
    return updatedFeedbackItem;
  }

  /**
   * Update the title of the feedback item.
   */
  public updateTitle = async (boardId: string, feedbackItemId: string, title: string): Promise<IFeedbackItemDocument> => {
    const feedbackItem: IFeedbackItemDocument = await this.getFeedbackItem(boardId, feedbackItemId);

    if (!feedbackItem) {
      //`Cannot update title for a non-existent feedback item. Board: ${boardId}, Item: ${feedbackItemId}`
      return undefined;
    }

    feedbackItem.title = title;

    const updatedFeedbackItem = await this.updateFeedbackItem(boardId, feedbackItem);
    return updatedFeedbackItem;
  }

  /**
   * Add a feedback item as a child feedback item of another feedback item.
   * This method also ensures that
   *   1) an existing parent-child association is removed from the old parent if the childFeedbackItem already had one.
   *   2) the existing children of the child feedback item (if any) become children of the specified parent 
   *   feedback item as well.
   *   3) that the child feedback item and the existing children of the child feedback item (if any) are 
   *   assigned the same columnId as the parent feedback item.
   */
  public addFeedbackItemAsChild = async (boardId: string, parentFeedbackItemId: string, childFeedbackItemId: string):
    Promise<{
      updatedParentFeedbackItem: IFeedbackItemDocument,
      updatedChildFeedbackItem: IFeedbackItemDocument,
      updatedOldParentFeedbackItem: IFeedbackItemDocument,
      updatedGrandchildFeedbackItems: IFeedbackItemDocument[]
    }> => {
    const parentFeedbackItem: IFeedbackItemDocument = await this.getFeedbackItem(boardId, parentFeedbackItemId);
    const childFeedbackItem: IFeedbackItemDocument = await this.getFeedbackItem(boardId, childFeedbackItemId);

    if (!parentFeedbackItem || !childFeedbackItem) {
      console.log(`Cannot add child for a non-existent feedback item. 
                Board: ${boardId}, 
                Parent Item: ${parentFeedbackItemId},
                Child Item: ${childFeedbackItemId}`);
      return undefined;
    }

    // The parent feedback item must not be a child of another group.
    if (parentFeedbackItem.parentFeedbackItemId) {
      console.log(`Cannot add child if parent is already a child in another group.
                Board: ${boardId}, 
                Parent Item: ${parentFeedbackItemId}`);
      return undefined;
    }

    if (parentFeedbackItem.childFeedbackItemIds) {
      parentFeedbackItem.childFeedbackItemIds.push(childFeedbackItemId);
    } else {
      parentFeedbackItem.childFeedbackItemIds = [childFeedbackItemId];
    }

    let updatedOldParentFeedbackItem: IFeedbackItemDocument;
    if (childFeedbackItem.parentFeedbackItemId) {
      const oldParentFeedbackItem: IFeedbackItemDocument = await this.getFeedbackItem(boardId, childFeedbackItem.parentFeedbackItemId);
      oldParentFeedbackItem.childFeedbackItemIds = oldParentFeedbackItem.childFeedbackItemIds
        .filter((existingchildFeedbackItemId) => existingchildFeedbackItemId !== childFeedbackItemId);
      updatedOldParentFeedbackItem = await this.updateFeedbackItem(boardId, oldParentFeedbackItem);
    }

    childFeedbackItem.parentFeedbackItemId = parentFeedbackItemId;

    let grandchildFeedbackItemPromises: Promise<IFeedbackItemDocument>[] = [];

    if (childFeedbackItem.childFeedbackItemIds) {
      grandchildFeedbackItemPromises = childFeedbackItem.childFeedbackItemIds.map((grandchildFeedbackItem) =>
        this.getFeedbackItem(boardId, grandchildFeedbackItem));
    }

    const grandchildFeedbackItems: IFeedbackItemDocument[] =
      await Promise.all(grandchildFeedbackItemPromises).then((promiseResults) => {
        return promiseResults.map((grandchildFeedbackItem) => {
          grandchildFeedbackItem.parentFeedbackItemId = parentFeedbackItemId;
          grandchildFeedbackItem.columnId = parentFeedbackItem.columnId;
          parentFeedbackItem.childFeedbackItemIds.push(grandchildFeedbackItem.id);
          return grandchildFeedbackItem;
        })
      });

    childFeedbackItem.childFeedbackItemIds = [];
    childFeedbackItem.columnId = parentFeedbackItem.columnId;

    const updatedParentFeedbackItem = await this.updateFeedbackItem(boardId, parentFeedbackItem);
    const updatedChildFeedbackItem = await this.updateFeedbackItem(boardId, childFeedbackItem);

    const updatedGrandchildFeedbackItemPromises: Promise<IFeedbackItemDocument>[] = grandchildFeedbackItems.map((grandchildFeedbackItem) =>
      this.updateFeedbackItem(boardId, grandchildFeedbackItem));

    const updatedGrandchildFeedbackItems: IFeedbackItemDocument[] =
      await Promise.all(updatedGrandchildFeedbackItemPromises).then((promiseResults) => {
        return promiseResults.map((updatedGrandchildFeedbackItem) => updatedGrandchildFeedbackItem)
      });

    return {
      updatedParentFeedbackItem,
      updatedChildFeedbackItem,
      updatedOldParentFeedbackItem,
      updatedGrandchildFeedbackItems,
    }
  }

  /**
   * Add the feedback item as main item to the column specified.
   * If the feedback item has a parent, the parent-child relationship is removed.
   * If the feedback item is being moved to a different column, its children are also updated.
   */
  public addFeedbackItemAsMainItemToColumn = async (boardId: string, feedbackItemId: string, newColumnId: string):
    Promise<{
      updatedOldParentFeedbackItem: IFeedbackItemDocument,
      updatedFeedbackItem: IFeedbackItemDocument,
      updatedChildFeedbackItems: IFeedbackItemDocument[]
    }> => {

    const feedbackItem: IFeedbackItemDocument = await this.getFeedbackItem(boardId, feedbackItemId);

    if (!feedbackItem) {
      console.log(`Cannot move a non-existent feedback item. 
              Board: ${boardId}, 
              Parent Item: ${feedbackItem.parentFeedbackItemId},
              Child Item: ${feedbackItemId}`);
      return undefined;
    }

    let updatedOldParentFeedbackItem: IFeedbackItemDocument;

    if (feedbackItem.parentFeedbackItemId) {
      const parentFeedbackItem: IFeedbackItemDocument = await this.getFeedbackItem(boardId, feedbackItem.parentFeedbackItemId);
      if (!parentFeedbackItem) {
        console.log(`The given feedback item has a non-existent parent. 
                Board: ${boardId}, 
                Parent Item: ${feedbackItem.parentFeedbackItemId},
                Child Item: ${feedbackItemId}`);
        return undefined;
      }

      parentFeedbackItem.childFeedbackItemIds = parentFeedbackItem.childFeedbackItemIds.filter((item) => item !== feedbackItemId);

      updatedOldParentFeedbackItem = await this.updateFeedbackItem(boardId, parentFeedbackItem);
    }

    let updatedChildFeedbackItems: IFeedbackItemDocument[] = []
    if (feedbackItem.columnId !== newColumnId && feedbackItem.childFeedbackItemIds) {
      let getChildFeedbackItemPromises: Promise<IFeedbackItemDocument>[] = [];

      getChildFeedbackItemPromises = feedbackItem.childFeedbackItemIds.map((childFeedbackItem) =>
        this.getFeedbackItem(boardId, childFeedbackItem));

      const childFeedbackItems =
        await Promise.all(getChildFeedbackItemPromises).then((promiseResults) => {
          return promiseResults.map((childFeedbackItem) => {
            childFeedbackItem.columnId = newColumnId;
            return childFeedbackItem;
          })
        });

      const updatedChildFeedbackItemPromises: Promise<IFeedbackItemDocument>[] = childFeedbackItems.map((childFeedbackItem) =>
        this.updateFeedbackItem(boardId, childFeedbackItem));
  
      updatedChildFeedbackItems =
        await Promise.all(updatedChildFeedbackItemPromises).then((promiseResults) => {
          return promiseResults.map((updatedChildFeedbackItem) => updatedChildFeedbackItem)
        });
    }

    feedbackItem.parentFeedbackItemId = null;
    feedbackItem.columnId = newColumnId;

    const updatedFeedbackItem = await this.updateFeedbackItem(boardId, feedbackItem);

    return Promise.resolve({
      updatedOldParentFeedbackItem,
      updatedFeedbackItem,
      updatedChildFeedbackItems
    });
  }

  /**
   * Add an associated work item to a feedback item.
   */
  public addAssociatedActionItem = async (boardId: string, feedbackItemId: string, associatedWorkItemId: number): Promise<IFeedbackItemDocument> => {
    let updatedFeedbackItem: IFeedbackItemDocument;

    try {
      updatedFeedbackItem = await this.getFeedbackItem(boardId, feedbackItemId);
    }
    catch (e) {
      appInsightsClient.trackException(new Error(e.message));
      console.log(`Failed to read Feedback item with id: ${feedbackItemId}.`);
      updatedFeedbackItem = undefined;
    }

    if (!updatedFeedbackItem) {
      return updatedFeedbackItem;
    }

    if (!updatedFeedbackItem.associatedActionItemIds) {
      updatedFeedbackItem.associatedActionItemIds = new Array<number>();
    }

    if (updatedFeedbackItem.associatedActionItemIds.find(wi => wi === associatedWorkItemId)) {
      return updatedFeedbackItem;
    }

    updatedFeedbackItem.associatedActionItemIds.push(associatedWorkItemId);

    await this.updateFeedbackItem(boardId, updatedFeedbackItem);
    return updatedFeedbackItem;
  }

  /**
   * Remove an associated work item from a feedback item.
   */
  public removeAssociatedActionItem = async (boardId: string, feedbackItemId: string, associatedActionItemId: number): Promise<IFeedbackItemDocument> => {
    let updatedFeedbackItem: IFeedbackItemDocument;

    try {
      updatedFeedbackItem = await this.getFeedbackItem(boardId, feedbackItemId);
    }
    catch (e) {
      appInsightsClient.trackException(new Error(e.message));
      console.log(`Failed to read Feedback item with id: ${feedbackItemId}.`);
      updatedFeedbackItem = undefined;
    }

    if (!updatedFeedbackItem || !updatedFeedbackItem.associatedActionItemIds) {
      return updatedFeedbackItem;
    }

    const updatedAssociatedList = updatedFeedbackItem.associatedActionItemIds.filter(workItemId => workItemId !== associatedActionItemId);
    updatedFeedbackItem.associatedActionItemIds = updatedAssociatedList;
    await this.updateFeedbackItem(boardId, updatedFeedbackItem);
    return updatedFeedbackItem;
  }

  /**
   * Get all associated work items of a feedback item.
   */
  public getAssociatedActionItemIds = async (boardId: string, feedbackItemId: string): Promise<number[]> => {
    let feedbackItem: IFeedbackItemDocument;

    try {
      feedbackItem = await this.getFeedbackItem(boardId, feedbackItemId);
    }
    catch (e) {
      appInsightsClient.trackException(new Error(e.message));
      throw new Error(`Failed to read Feedback item with id: ${feedbackItemId}.`);
    }

    if (!feedbackItem) {
      throw new Error(`Feedback item with id: ${feedbackItemId} not found.`);
    }

    if (!feedbackItem.associatedActionItemIds) {
      return new Array<number>();
    }

    return feedbackItem.associatedActionItemIds;
  }

  /**
   * Checks if the work item exists in VSTS and if not, removes it.
   * This handles the special case for when a work item is deleted in VSTS. Currently, when a work item is updated using the navigation form service
   * there is no way to determine if the item was deleted.
   * https://github.com/MicrosoftDocs/vsts-docs/issues/1545 
   */
  public removeAssociatedItemIfNotExistsInVsts = async (boardId: string, feedbackItemId: string, associatedWorkItemId: number): Promise<IFeedbackItemDocument> => {
    let workItems: WorkItem[];

    try {
      workItems = await workItemService.getWorkItemsByIds([associatedWorkItemId]);
    }
    catch (e) {
      appInsightsClient.trackException(new Error(e.message));
      return await this.removeAssociatedActionItem(boardId, feedbackItemId, associatedWorkItemId);
    }

    if (!workItems || !workItems.length) {
      return await this.removeAssociatedActionItem(boardId, feedbackItemId, associatedWorkItemId);
    }

    return await this.getFeedbackItem(boardId, feedbackItemId);
  }
}

export const itemDataService = new ItemDataService();
