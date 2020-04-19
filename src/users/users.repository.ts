import { Injectable } from '@nestjs/common'
import { User, UserProfile } from './interfaces/user.interface'
import { FirebaseService } from '../firebase/firebase.service'
import * as firebaseAdmin from 'firebase-admin'
import {
  TEMPID_VALIDITY_PERIOD,
  TEMPID_SWITCHOVER_TIME,
  POSITIVE_RECOVERY_PERIOD,
  POSITIVE_REPRODUCTION_PERIOD,
} from './constants'
import * as moment from 'moment-timezone'
import { TempID } from './interfaces/temp-id.interface'

@Injectable()
export class UsersRepository {
  private readonly firestoreDB: Promise<firebaseAdmin.firestore.Firestore>
  private readonly firestoreStorage: Promise<firebaseAdmin.storage.Storage>

  constructor(private firebaseService: FirebaseService) {
    this.firestoreDB = this.firebaseService.Firestore()
    this.firestoreStorage = this.firebaseService.Storage()
  }

  async createOne(user: User, userProfile?: UserProfile): Promise<void> {
    await (await this.firestoreDB)
      .collection('users')
      .doc(user.userId)
      .set(JSON.parse(JSON.stringify(user)))

    if (userProfile) {
      await (await this.firestoreDB)
        .collection('users')
        .doc(user.userId)
        .collection('profile')
        .doc(user.userId)
        .set(JSON.parse(JSON.stringify(userProfile)))
    }
  }

  async findOneById(userId: string): Promise<User | undefined> {
    const getDoc = await (await this.firestoreDB)
      .collection('users')
      .doc(userId)
      .get()
    return getDoc.data() as User
  }

  async generateTempId(userId: string, i: number): Promise<TempID> {
    const yesterday = moment.tz('Asia/Tokyo').subtract(1, 'day')
    const startTime = yesterday
      .startOf('day')
      .hour(TEMPID_SWITCHOVER_TIME)
      .add(TEMPID_VALIDITY_PERIOD * i, 'hours')
    const validFrom = startTime.clone().toDate()
    const validTo = startTime.add(TEMPID_VALIDITY_PERIOD, 'hours').toDate()

    const collection = (await this.firestoreDB)
      .collection('userStatuses')
      .doc(userId)
      .collection('tempIDs')

    let tempID = await collection
      .where('validFrom', '==', validFrom)
      .where('validTo', '==', validTo)
      .limit(1)
      .get()
      .then((query) => {
        return query.docs.length === 0 ? undefined : query.docs[0].id
      })

    tempID =
      tempID ||
      (await collection.add({ validFrom, validTo }).then((doc) => {
        return doc.id
      }))

    return {
      tempID,
      validFrom,
      validTo,
    }
  }

  async uploadPositiveList(): Promise<null> {
    const recoveredDate = moment
      .tz('Asia/Tokyo')
      .subtract(POSITIVE_RECOVERY_PERIOD, 'days')
      .startOf('day')

    // NOTE : need to create a composite index on Cloud Firestore
    const userIDs = await (await this.firestoreDB)
      .collection('userStatuses')
      .where('positive', '==', true)
      .where('testDate', '>=', recoveredDate)
      .get()
      .then((query) => {
        return query.docs.map((doc) => {
          return { id: doc.id, testDate: doc.data().testDate }
        })
      })

    const tempIDs = await Promise.all(
      userIDs.map(async (doc) => {
        const id = doc.id
        const testDate = doc.testDate
        const reproductionDate = moment(testDate)
          .subtract(POSITIVE_REPRODUCTION_PERIOD, 'days')
          .startOf('day')

        return (
          (await this.firestoreDB)
            .collection('userStatuses')
            .doc(id)
            .collection('tempIDs')
            .where('validFrom', '>=', reproductionDate)
            // FIXME @shogo-mitomo : cannot have inequality filters on multiple properties
            // .where('validTo', '<=', testDate)
            .get()
            .then((query) => {
              return query.docs.map((doc) => {
                return { uuid: doc.id }
              })
            })
        )
      })
    )

    const file = (await this.firestoreStorage).bucket().file('positives.json')
    const json = JSON.stringify({ data: [].concat(...tempIDs) })

    // FIXME @shogo-mitomo : gzip compression
    await file.save(json)
    await file.setMetadata({ contentType: 'application/json' })

    return
  }
}
