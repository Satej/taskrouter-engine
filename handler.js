const AWS = require("aws-sdk");
const express = require("express");
const serverless = require("serverless-http");

const app = express();

const TASKS_TABLE = process.env.TASKS_TABLE;
const WORKERS_TABLE = process.env.WORKERS_TABLE;
const QUEUES_TABLE = process.env.QUEUES_TABLE;
const WORKSPACES_TABLE = process.env.WORKSPACES_TABLE;
const RESERVATIONS_TABLE = process.env.RESERVATIONS_TABLE;
const RESERVATIONS_TIMEOUT_TABLE = process.env.RESERVATIONS_TIMEOUT_TABLE;
const ACTIVITIES_TABLE = process.env.ACTIVITIES_TABLE;
const EVENTS_TABLE = process.env.EVENTS_TABLE;
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE;
const WORKER_ATTRIBUTES_TABLE = process.env.WORKER_ATTRIBUTES_TABLE;
const WORKER_QUEUE_TABLE = process.env.WORKER_QUEUE_TABLE;
const dynamoDbClient = new AWS.DynamoDB.DocumentClient();
const dynamoDb = new AWS.DynamoDB();
const { SQS } = require("aws-sdk");
const sqs = new SQS();
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

app.use(express.json());

app.post("/workers", async function (req, res) {
  let { attributes, activityId, workspaceId } = req.body;

  if (typeof attributes !== "object") {
    res.status(400).json({ error: '"attributes" must be a object' });
  } else if (typeof workspaceId !== "string") {
    res.status(400).json({ error: '"workspaceId" must be a string' });
  } else if (typeof activityId === "undefined") {
    const params = {
      TableName: WORKSPACES_TABLE,
      Key: {
        id: workspaceId,
      },
      ProjectionExpression: 'defaultActivityId',
    };

    const workspace = await dynamoDbClient.get(params).promise();
    activityId = workspace.Item.defaultActivityId;
  } else if (typeof activityId !== "string") {
    res.status(400).json({ error: '"activityId" must be a string' });
  }

  const id = uuidv4();

  try {
    let params = {
      TableName: ACTIVITIES_TABLE,
      Key: {
        id: activityId,
      },
    };
    const { Item } = await dynamoDbClient.get(params).promise();

    if (Item) {
      const { isAvailable } = Item;
      const id = uuidv4();

      params = {
        TableName: WORKERS_TABLE,
        Item: {
          id,
          workspaceId,
          isAvailable,
          activityId,
          dateCreated: (new Date()).toUTCString(),
          attributes,
          lastAssignedDate: "0",
          version: 0,
        },
      };

      await dynamoDbClient.put(params).promise();

      for (let attributeName in attributes) {
        if (attributes.hasOwnProperty(attributeName)) {
          const attributeValue = attributes[attributeName];

          params = {
            TableName: WORKER_ATTRIBUTES_TABLE,
            Item: {
              id: uuidv4(),
              attributeName,
              attributeValue,
              workerId: id,
              workspaceId,
	    }
	  };

          await dynamoDbClient.put(params).promise();

          params = {
            ExpressionAttributeValues: {
              ":workspaceId": {
                S: workspaceId
              },
              ":attributeName": {
                S: attributeName
              },
              ":attributeValue": {
                S: attributeValue
              }
            },
            KeyConditionExpression: 'workspaceId = :workspaceId',
            FilterExpression: 'attributeName = :attributeName and attributeValue = :attributeValue',
            ProjectionExpression: 'id',
            TableName: QUEUES_TABLE,
          };

          const queues = await dynamoDb.query(params).promise();

          if (queues.Items.length) {
            for (let queue of queues.Items) {
	      console.log(queue);
              params = {
                TableName: WORKER_QUEUE_TABLE,
                Key: {
                  queueId: queue.id.S,
                  workerId: id
                },
              };

              await dynamoDbClient.delete(params).promise();

              params = {
                TableName: WORKER_QUEUE_TABLE,
                Item: {
                  id: uuidv4(),
                  workerId: id,
                  queueId: queue.id.S,
                  workspaceId,
                }
              };
              await dynamoDbClient.put(params).promise();
            }
          }
        }
      }

      res.json({ id, activityId, workspaceId, attributes });
    } else {
      res.status(400).json({ error: 'Activity not found' });
    }
    res.status(200)
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Could not create worker" });
  }
});

app.patch("/workers", async function (req, res) {
  const { id, attributes, activityId, workspaceId } = req.body;

  if (typeof attributes !== "object") {
    res.status(400).json({ error: '"attributes" must be a object' });
  } else if (typeof id !== "string") {
    res.status(400).json({ error: '"id" must be a string' });
  } else if (typeof activityId !== "string") {
    res.status(400).json({ error: '"activityId" must be a string' });
  } else if (typeof workspaceId !== "string") {
    res.status(400).json({ error: '"workspaceId" must be a string' });
  }

  try {
    let params = {
      TableName: ACTIVITIES_TABLE,
      Key: {
        id: activityId,
      },
    };
    const { Item } = await dynamoDbClient.get(params).promise();

    if (!Item) {
      return res.status(400).json({ error: 'Activity not found' });
    }

    const { isAvailable } = Item;

    params = {
      TableName: WORKERS_TABLE,
      ExpressionAttributeValues: {
        ':attributes': attributes.skills,
        ':activityId': activityId,
        ':isAvailable': isAvailable,
      },
      Key: {
        workspaceId,
        id,
      },
      UpdateExpression: 'set attributes.skills = :attributes, activityId = :activityId, isAvailable = :isAvailable',
    };
    await dynamoDbClient.update(params).promise();

    params = {
      TableName: WORKER_ATTRIBUTES_TABLE,
      Key: {
        workspaceId,
        workerId: id,
      },
    };
    await dynamoDbClient.delete(params).promise();

    for (let attributeName in attributes) {
      if (attributes.hasOwnProperty(attributeName)) {
        const attributeValue = attributes[attributeName];

        params = {
          TableName: WORKER_ATTRIBUTES_TABLE,
          Item: {
            id: uuidv4(),
            attributeName,
            attributeValue,
            workerId: id,
            workspaceId,
          }
        };

        await dynamoDbClient.put(params).promise();

        params = {
          ExpressionAttributeValues: {
            ":workspaceId": {
              S: workspaceId
            },
            ":attributeName": {
              S: attributeName
            },
            ":attributeValue": {
              S: attributeValue
            }
          },
          KeyConditionExpression: 'workspaceId = :workspaceId',
          FilterExpression: 'attributeName = :attributeName and attributeValue = :attributeValue',
          ProjectionExpression: 'id',
          TableName: QUEUES_TABLE,
        };

        const queues = await dynamoDb.query(params).promise();

        if (queues.Items.length) {
          for (let queue of queues.Items) {
            params = {
              TableName: WORKER_QUEUE_TABLE,
              Key: {
                queueId: queue.id.S,
                workerId: id
              },
            };

            await dynamoDbClient.delete(params).promise();

            params = {
              TableName: WORKER_QUEUE_TABLE,
              Item: {
                id: uuidv4(),
                workerId: id,
                queueId: queue.id.S,
                workspaceId,
              }
            };
            await dynamoDbClient.put(params).promise();
          }
        }
      }
    }

    res.json({ id, activityId, workspaceId, attributes });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Could not update worker" });
  }
});

app.post("/activities", async function (req, res) {
  const { name, isAvailable, workspaceId } = req.body;

  if (typeof name !== "string") {
    res.status(400).json({ error: '"name" must be a string' });
  } else if (typeof isAvailable !== "string") {
    res.status(400).json({ error: '"isAvailable" must be a string' });
  } else if (typeof workspaceId !== "string") {
    res.status(400).json({ error: '"workspaceId" must be a string' });
  }

  const id = uuidv4();

  const params = {
    TableName: ACTIVITIES_TABLE,
    Item: {
      id,
      workspaceId,
      isAvailable,
      dateCreated: (new Date()).toUTCString(),
      name,
    },
  };

  try {
    await dynamoDbClient.put(params).promise();
    res.json({ id, name, workspaceId, isAvailable });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Could not create activity" });
  }
});

app.post("/tasks", async function (req, res) {
  const { workspaceId, workflowId, attributes } = req.body;

  if (typeof workspaceId !== "string") {
    res.status(400).json({ error: '"workspaceId" must be a string' });
  } else if (typeof workflowId !== "string") {
    res.status(400).json({ error: '"workflowId" must be a string' });
  } else if (typeof attributes !== "object") {
    res.status(400).json({ error: '"attributes" must be a object' });
  }

  let params = {
    TableName: WORKFLOWS_TABLE,
    Key: {
      id: workflowId,
      workspaceId,
    },
  };

  try {
    const { Item } = await dynamoDbClient.get(params).promise();

    if (!Item) {
      return res.status(400).json({ error: 'Workflow not found' });
    }

    const { filters } = Item;
    let queueId,
        acceptanceActivityId,
        reservationActivityId;

    filterBlock:
    for (let filter of filters) {
      const search = filter.condition.split("==");
      const property = search[0].trim();
      const value = search[1].trim();

      for (let key in attributes) {
        if (attributes.hasOwnProperty(key)) {
          if (key == property && value == attributes[key]) {
            queueId = filter.queueId;
            break filterBlock;
	        }
        }
      }
    }

    if (!queueId) {
      return res.status(400).json({ error: 'No matching queue or activity found' });
    }

    params = {
      TableName: QUEUES_TABLE,
      Key: {
        workspaceId,
        id: queueId,
      },
      ProjectionExpression: 'acceptanceActivityId, reservationActivityId',
    };
    const queue = await dynamoDbClient.get(params).promise();
    const id = uuidv4();
    const currentStatus = "pending";

    params = {
      TableName: WORKSPACES_TABLE,
      Key: {
        id: workspaceId,
      },
      ProjectionExpression: 'timeoutActivityId',
    };
    const workspace = await dynamoDbClient.get(params).promise();

    params = {
      TableName: TASKS_TABLE,
      Item: {
        id,
        workspaceId,
        workflowId,
        currentStatus,
        dateCreated: (new Date()).toUTCString(),
        queueId,
        acceptanceActivityId: queue.Item.acceptanceActivityId,
        reservationActivityId: queue.Item.reservationActivityId,
        timeoutActivityId: workspace.Item.timeoutActivityId,
        attributes,
        reservationTimeout: Item.taskReservationTimeout,
      },
    };

    await dynamoDbClient.put(params).promise();
    res.json({ id, workspaceId, workflowId, currentStatus, queueId, attributes });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Could not create task" });
  }
});

app.post("/workflows", async function (req, res) {
  const { workspaceId, filters, taskReservationTimeout } = req.body;

  if (typeof workspaceId !== "string") {
    res.status(400).json({ error: '"workspaceId" must be a string' });
  } else if (typeof filters !== "object") {
    res.status(400).json({ error: '"filters" must be an object' });
  } else if (typeof taskReservationTimeout !== "number") {
    res.status(400).json({ error: '"taskReservationTimeout" must be a number' });
  }

  const id = uuidv4();

  const params = {
    TableName: WORKFLOWS_TABLE,
    Item: {
      id,
      workspaceId,
      dateCreated: (new Date()).toUTCString(),
      filters,
      taskReservationTimeout,
    },
  };

  try {
    await dynamoDbClient.put(params).promise();
    res.json({ id, workspaceId, filters });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Could not create workflow" });
  }
});

app.post("/queues", async function (req, res) {
  const {
    workspaceId,
    attributeName,
    attributeValue,
    name,
    reservationActivityId,
    acceptanceActivityId,
  } = req.body;

  if (typeof workspaceId !== "string") {
    res.status(400).json({ error: '"workspaceId" must be a string' });
  } else if (typeof name !== "string") {
    res.status(400).json({ error: '"name" must be a string' });
  } else if (typeof attributeName !== "string") {
    res.status(400).json({ error: '"attributeName" must be a string' });
  } else if (typeof attributeValue === "object" || typeof attributeValue === "undefined") {
    res.status(400).json({ error: '"attributeValue" must not be json' });
  } else if (typeof reservationActivityId !== "string") {
    res.status(400).json({ error: '"reservationActivityId" must be a string' });
  } else if (typeof acceptanceActivityId !== "string") {
    res.status(400).json({ error: '"acceptanceActivityId" must be a string' });
  }

  const id = uuidv4();

  let params = {
    TableName: QUEUES_TABLE,
    Item: {
      id,
      workspaceId,
      name,
      dateCreated: (new Date()).toUTCString(),
      attributeName,
      attributeValue,
      reservationActivityId,
      acceptanceActivityId,
    },
  };

  try {
    await dynamoDbClient.put(params).promise();

    params = {
      ExpressionAttributeValues: {
        ":workspaceId": {
          S: workspaceId
        },
        ":attributeName": {
          S: attributeName
        },
     	  ":attributeValue": {
          S: attributeValue
	      }
      },
      KeyConditionExpression: 'workspaceId = :workspaceId',
      FilterExpression: 'attributeName = :attributeName and attributeValue = :attributeValue',
      ProjectionExpression: 'workerId',
      TableName: WORKER_ATTRIBUTES_TABLE,
    };

    const workers = await dynamoDb.query(params).promise();

    if (workers.Items.length) {
      for (let worker of workers.Items) {
        params = {
          TableName: WORKER_QUEUE_TABLE,
          Key: {
            workerId: worker.workerId.S,
            queueId: id
          },
        };

        await dynamoDbClient.delete(params).promise();

        params = {
          TableName: WORKER_QUEUE_TABLE,
          Item: {
            id: uuidv4(),
            queueId: id,
            workerId: worker.workerId.S,
            workspaceId,
          }
        };
        await dynamoDbClient.put(params).promise();
      }
    }

    res.json({ id, workspaceId, attributeName, attributeValue });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Could not create queue" });
  }
});

app.patch("/reservations", async (req, res) => {
  let { workerId, reservationId, status, workspaceId } = req.body;
  
  if (typeof workerId !== "string") {
    res.status(400).json({ error: '"workerId" must be a string' });
  } else if (typeof reservationId !== "string") {
    res.status(400).json({ error: '"reservationId" must be a string' });
  } else if (typeof status !== "string") {
    res.status(400).json({ error: '"status" must be a string' });
  } else if (typeof workspaceId !== "string") {
    res.status(400).json({ error: '"workspaceId" must be a string' });
  }
  
  const params = {
    TableName: RESERVATIONS_TABLE,
    Key: {
      workspaceId: workspaceId,
      id: reservationId,
    },
    UpdateExpression: 'set currentStatus = :currentStatus, workerId = :workerId',
    ExpressionAttributeValues: {
      ':currentStatus': status,
      ':workerId': workerId,
    }
  };

  try {
    await dynamoDbClient.update(params).promise();
    res.json({ reservationId, workerId, workspaceId, currentStatus: status, });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Could not update reservation" });
  }
});

app.post("/workspaces", async function (req, res) {
  let { name, eventCallbackUrl } = req.body;

  if (typeof name !== "string") {
    res.status(400).json({ error: '"name" must be a string' });
  } else if (typeof eventCallbackUrl === "undefined") {
    eventCallbackUrl = '';
  } else if (typeof eventCallbackUrl !== "string") {
    res.status(400).json({ error: '"eventCallbackUrl" must be a string' });
  }

  const id = uuidv4();

  let params = {
    TableName: WORKSPACES_TABLE,
    Item: {
      id,
      dateCreated: (new Date()).toUTCString(),
      name,
      eventCallbackUrl,
    },
  };

  try {
    await dynamoDbClient.put(params).promise();

    const activityId = uuidv4();
    params = {
      TableName: ACTIVITIES_TABLE,
      Item: {
        id: activityId,
        workspaceId: id,
        isAvailable: 'false',
        dateCreated: (new Date()).toUTCString(),
        name: 'Offline',
      },
    };
    await dynamoDbClient.put(params).promise();

    params = {
      TableName: WORKSPACES_TABLE,
      Key: {
        id,
      },
      UpdateExpression: 'set defaultActivityId = :activityId, timeoutActivityId = :activityId',
      ExpressionAttributeValues: {
        ':activityId': activityId,
      }
    };
    await dynamoDbClient.update(params).promise();

    const data = {
      name,
      id,
      eventCallbackUrl,
      defaultActivityId: activityId,
      timeoutActivityId: activityId,
    };
    await sendEvent('CREATE', 'WORKSPACE', id, data);

    res.json({ name, id, defaultActivityId: activityId, timeoutActivityId: activityId });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Could not create workspace" });
  }
});

app.use((req, res, next) => {
  return res.status(404).json({
    error: "Not Found",
  });
});

const workerStreamConsumer = (event, context, callback) => {
  console.log(JSON.stringify(event, null, 2));

  event.Records.forEach(async function(record) {
    console.log(record.eventID);
    console.log(record.eventName);
    console.log('DynamoDB Record: %j', record.dynamodb);
    
    let params = {
	    ExpressionAttributeValues: {
			  ":workspaceId": {
					S: record.dynamodb.Keys.workspaceId.S,
				},
			  ":isAvailable": {
				  S: "true",
			  }
		  },
	    KeyConditionExpression: "isAvailable = :isAvailable",
	    FilterExpression: "workspaceId = :workspaceId",
	    ProjectionExpression: "id",
			TableName: WORKERS_TABLE,
	    IndexName: "lastAssignedDateIndex",
	    Limit: 100,
	  };
    const result = await dynamoDb.query(params).promise();

    try {
      for (let worker of result.Items) {
        params = {
          ExpressionAttributeValues: {
            ":workspaceId": {
              S: record.dynamodb.Keys.workspaceId.S,
            },
            ":workerId": {
              S: worker.id.S,
            },
          },
          FilterExpression: 'workerId = :workerId and workspaceId = :workspaceId',
          ProjectionExpression: 'queueId',
          TableName: WORKER_QUEUE_TABLE,
        };
  
        const queues = await dynamoDb.scan(params).promise();
  
        if (!queues.Items.length) return true;
  
        let index = 0;
        let queueIdIndexes = [];
  
        const ExpressionAttributeValues = {
          ":workspaceId": {
            S: record.dynamodb.Keys.workspaceId.S,
          },
          ":currentStatus": {
            S: "pending"
          }
        };
  
        for (let queue of queues.Items) {
          const queueIdMarker = `:queueId${index}`;
          ExpressionAttributeValues[queueIdMarker] = { S: queue.queueId.S };
          queueIdIndexes.push(queueIdMarker);
          index++;
        }
  
        params = {
          ExpressionAttributeValues,
          KeyConditionExpression: 'workspaceId = :workspaceId',
          FilterExpression: `queueId IN (${ queueIdIndexes.join(',') }) and currentStatus = :currentStatus`,
          ProjectionExpression: 'id, timeoutActivityId, acceptanceActivityId, reservationActivityId, reservationTimeout',
          TableName: TASKS_TABLE,
        };
  
        const data = await dynamoDb.query(params).promise();
  
        if (data && data.Count) {
      	  let item = data.Items[0];
          let params = {
            TableName: RESERVATIONS_TABLE,
            Item: {
              id: uuidv4(),
              workerId: worker.id.S,
              workspaceId: record.dynamodb.Keys.workspaceId.S,
              dateCreated: (new Date()).toUTCString(),
              taskId: item.id.S,
              currentStatus: "reserved",
              acceptanceActivityId: item.acceptanceActivityId.S,
              timeoutActivityId: item.timeoutActivityId.S,
              reservationActivityId: item.reservationActivityId.S,
              timeout: (Math.floor(Date.now() / 1000) + parseInt(item.reservationTimeout.N)).toString(),
            },
          };
          await dynamoDbClient.put(params).promise();

          params = {
            TableName: WORKERS_TABLE,
            Key: {
              workspaceId: record.dynamodb.Keys.workspaceId.S,
              id: worker.id.S,
            },
            UpdateExpression: 'set isAvailable = :isAvailable, activityId = :activityId',
            ExpressionAttributeValues: {
             ':isAvailable': "false",
             ':activityId': item.reservationActivityId.S,
            }
          };
          await dynamoDbClient.update(params).promise();

          params = {
            TableName: TASKS_TABLE,
            Key: {
              workspaceId: record.dynamodb.Keys.workspaceId.S,
              id: item.id.S,
            },
            UpdateExpression: 'set currentStatus = :currentStatus',
            ExpressionAttributeValues: {
             ':currentStatus': "reserved",
            }
          };
          await dynamoDbClient.update(params).promise();
        }
      }
    } catch (error) {
      console.log(error);
    }
  });
  callback(null, "message");
};

const taskStreamConsumer = (event, context, callback) => {
  console.log(JSON.stringify(event, null, 2));

  event.Records.forEach(async function(record) {
    console.log(record.eventID);
    console.log(record.eventName);
    console.log('DynamoDB Record: %j', record.dynamodb);
    
    if (record.dynamodb.NewImage.currentStatus !== "pending") return;
    
    let params = {
	    ExpressionAttributeValues: {
			  ":workspaceId": {
					S: record.dynamodb.Keys.workspaceId.S,
				},
			  ":isAvailable": {
				  S: "true",
			  }
		  },
	    KeyConditionExpression: "isAvailable = :isAvailable",
	    FilterExpression: "workspaceId = :workspaceId",
	    ProjectionExpression: "id",
			TableName: WORKERS_TABLE,
	    IndexName: "lastAssignedDateIndex",
	    Limit: 1,
	  };
    const result = await dynamoDb.query(params).promise();

    try {
      if (result.Items.length) {
        let worker = result.Items[0];
        params = {
          ExpressionAttributeValues: {
            ":workspaceId": {
              S: record.dynamodb.Keys.workspaceId.S,
            },
            ":queueId": {
              S: record.dynamodb.NewImage.queueId.S,
            },
          },
          FilterExpression: 'queueId = :queueId and workspaceId = :workspaceId',
          ProjectionExpression: 'workerId',
          TableName: WORKER_QUEUE_TABLE,
        };
  
        const workers = await dynamoDb.scan(params).promise();
  
        if (!workers.Items.length) return true;
  
        for (let wrkr of workers.Items) {
          if (wrkr.workerId.S === worker.id.S) {
            params = {
              TableName: RESERVATIONS_TABLE,
              Item: {
                id: uuidv4(),
                workerId: worker.id.S,
                workspaceId: record.dynamodb.Keys.workspaceId.S,
                dateCreated: (new Date()).toUTCString(),
                taskId: record.dynamodb.Keys.id.S,
                currentStatus: "reserved",
                acceptanceActivityId: record.dynamodb.NewImage.acceptanceActivityId.S,
                timeoutActivityId: record.dynamodb.NewImage.timeoutActivityId.S,
                reservationActivityId: record.dynamodb.NewImage.reservationActivityId.S,
                timeout: (Math.floor(Date.now() / 1000) + parseInt(record.dynamodb.NewImage.reservationTimeout.N)).toString(),
              },
            };
            await dynamoDbClient.put(params).promise();
  
            params = {
              TableName: TASKS_TABLE,
              Key: {
                workspaceId: record.dynamodb.Keys.workspaceId.S,
                id: record.dynamodb.Keys.id.S,
              },
              UpdateExpression: 'set currentStatus = :currentStatus',
              ExpressionAttributeValues: {
               ':currentStatus': "reserved",
              }
            };
            await dynamoDbClient.update(params).promise();
  
            params = {
              TableName: WORKERS_TABLE,
              Key: {
                workspaceId: record.dynamodb.Keys.workspaceId.S,
                id: worker.id.S,
              },
              UpdateExpression: 'set isAvailable = :isAvailable, activityId = :activityId',
              ExpressionAttributeValues: {
               ':isAvailable': "false",
               ':activityId': record.dynamodb.NewImage.reservationActivityId.S,
              }
            };
            await dynamoDbClient.update(params).promise();
            break;
          }
        }
      }
    } catch (error) {
      console.log(error);
    }
  });
  callback(null, "message");
};

const reservationStreamConsumer = (event, context, callback) => {
  console.log(JSON.stringify(event, null, 2));

  event.Records.forEach(async function(record) {
    console.log(record.eventID);
    console.log(record.eventName);
    console.log('DynamoDB Record: %j', record.dynamodb);
    let params;

    switch (record.dynamodb.NewImage.currentStatus.S) {
      case 'reserved':
        params = {
          TableName: RESERVATIONS_TIMEOUT_TABLE,
          Item: {
            id: uuidv4(),
            workerId: record.dynamodb.NewImage.workerId.S,
            workspaceId: record.dynamodb.NewImage.workspaceId.S,
            dateCreated: (new Date()).toUTCString(),
            taskId: record.dynamodb.NewImage.taskId.S,
            reservationId: record.dynamodb.NewImage.id.S,
            currentStatus: "reserved",
            ttl: +record.dynamodb.NewImage.timeout.S,
            timeout: +record.dynamodb.NewImage.timeout.S,
            reservationActivityId: record.dynamodb.NewImage.reservationActivityId.S,
            acceptanceActivityId: record.dynamodb.NewImage.acceptanceActivityId.S,
            timeoutActivityId: record.dynamodb.NewImage.timeoutActivityId.S,
          },
        };
        await dynamoDbClient.put(params).promise();
        break;
      case 'accepted':
      case 'rejected':
        params = {
          TableName: TASKS_TABLE,
          Key: {
            workspaceId: record.dynamodb.NewImage.workspaceId.S,
            id: record.dynamodb.NewImage.taskId.S,
          },
          UpdateExpression: 'set currentStatus = :currentStatus',
          ExpressionAttributeValues: {
           ':currentStatus': record.dynamodb.NewImage.currentStatus.S === "accepted" ? "accepted" : "pending",
          }
        };
        await dynamoDbClient.update(params).promise();

        params = {
          TableName: WORKERS_TABLE,
          Key: {
            workspaceId: record.dynamodb.NewImage.workspaceId.S,
            id: record.dynamodb.NewImage.workerId.S,
          },
          UpdateExpression: 'set isAvailable = :isAvailable, activityId = :activityId, lastAssignedDate = :lastAssignedDate',
          ExpressionAttributeValues: {
           ':isAvailable': "false",
           ':activityId': record.dynamodb.NewImage.acceptanceActivityId.S,
           ':lastAssignedDate': Math.floor(Date.now() / 1000).toString(),
          }
        };
        await dynamoDbClient.update(params).promise();
        break;
    }
  });
  callback(null, "message");
};

const reservationTimeoutStreamConsumer = (event, context, callback) => {
  console.log(JSON.stringify(event, null, 2));

  event.Records.forEach(async function(record) {
    console.log(record.eventID);
    console.log(record.eventName);
    console.log('DynamoDB Record: %j', record.dynamodb);

    if (record.eventName !== 'REMOVE') {
      return true;
    }

    let params = {
      TableName: TASKS_TABLE,
      Key: {
        workspaceId: record.dynamodb.OldImage.workspaceId.S,
        id: record.dynamodb.OldImage.taskId.S,
      },
      UpdateExpression: 'set currentStatus = :currentStatus',
      ExpressionAttributeValues: {
        ':currentStatus': "pending",
      }
    };
    await dynamoDbClient.update(params).promise();

    params = {
      TableName: RESERVATIONS_TABLE,
      Key: {
        workspaceId: record.dynamodb.OldImage.workspaceId.S,
        id: record.dynamodb.OldImage.reservationId.S,
      },
      UpdateExpression: 'set currentStatus = :currentStatus',
      ExpressionAttributeValues: {
        ':currentStatus': 'timedout',
      }
    };
    await dynamoDbClient.update(params).promise();

    params = {
      TableName: WORKERS_TABLE,
      Key: {
        workspaceId: record.dynamodb.OldImage.workspaceId.S,
        id: record.dynamodb.OldImage.workerId.S,
      },
      UpdateExpression: 'set isAvailable = :isAvailable, activityId = :activityId',
      ExpressionAttributeValues: {
        ':isAvailable': "false", //TODO: should be dynamic.
        ':activityId': record.dynamodb.OldImage.timeoutActivityId.S,
      }
    };
    await dynamoDbClient.update(params).promise();
  });
  callback(null, "message");
};

const removeTimedoutReservations = async (event, context, callback) => {
  let secs = 0;

  while (secs < 45) {
    let params = {
      ExpressionAttributeValues: {
        ":ttl": {
          N: Math.floor(Date.now() / 1000).toString()
        },
      },
      FilterExpression: 'timeout < :ttl',
      ProjectionExpression: 'workspaceId, reservationId',
      TableName: RESERVATIONS_TIMEOUT_TABLE,
    };
    const timeouts = await dynamoDb.scan(params).promise();

    if (timeouts.Items.length) {
      for (let timeout of timeouts.Items) {
        params = {
          TableName: RESERVATIONS_TIMEOUT_TABLE,
          Key: {
            workspaceId: timeout.workspaceId.S,
            reservationId: timeout.reservationId.S,
          },
        };
        await dynamoDbClient.delete(params).promise();    
      }
    }

    await delayTime(15);
    secs += 15;
    console.log(`${secs} run: ${new Date()}`);
  }
};

const delayTime = async secs => new Promise((res, rej) => setTimeout(() => res(1), secs * 1000));

const sendEvent = (eventType, eventEntity, workspaceId, data) => {
  return sqs.sendMessage({
    QueueUrl: process.env.QUEUE_URL,
    MessageBody: JSON.stringify({
      eventType,
      eventEntity,
      workspaceId,
      dateCreated: (new Date()).toUTCString(),
      data,
    }),
    MessageAttributes: {
      EventType: {
        StringValue: eventType,
        DataType: "String",
      },
    },
  })
  .promise();
};

const processEvents = async (event) => {
  for (const record of event.Records) {
    console.log("Message Body: ", record.body);
    const messageAttributes = record.messageAttributes;
    console.log("Message Attribute: ", messageAttributes.EventType.stringValue);
    const payload = JSON.parse(record.body);

    const params = {
      TableName: EVENTS_TABLE,
      Item: {
        id: uuidv4(),
        ...payload,
      },
    };
    await dynamoDbClient.put(params).promise()

    if (workspace.Item.eventCallbackUrl) {
      const config = {
        method: 'post',
        url: workspace.Item.eventCallbackUrl,
        headers: {
          'Content-Type': 'application/json'
        },
        data: params.Item,
      };

      const response = await axios(config);
      console.log(JSON.stringify(response.data));
    }

    params = {
      TableName: WORKSPACES_TABLE,
      Key: {
        id: payload.workspaceId,
      },
      ProjectionExpression: 'eventCallbackUrl',
    };
    const workspace = await dynamoDbClient.get(params).promise();
  }
};

module.exports.handler = serverless(app);
module.exports.taskStreamConsumer = taskStreamConsumer;
module.exports.workerStreamConsumer = workerStreamConsumer;
module.exports.reservationStreamConsumer = reservationStreamConsumer;
module.exports.reservationTimeoutStreamConsumer = reservationTimeoutStreamConsumer;
module.exports.removeTimedoutReservations = removeTimedoutReservations;
module.exports.processEvents = processEvents;
